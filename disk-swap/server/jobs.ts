import { readFileSync, unlinkSync } from "node:fs";
import type { Device, Job, JobMode, StageName, StageState, StageStatus, WsMessage } from "../shared/types.ts";

const JOB_FILE = "/data/current_job.json";

/**
 * Rehydrate persisted job state on startup.
 *
 * No pipeline is running after a restart, so any "in_progress" stage represents
 * work that was interrupted. We can't resume it, so we reconcile state:
 *
 *  - sandbox in_progress → completed (disk is fully usable without sandbox; UI
 *    avoids showing a dead iframe pointing at a stopped inner HA).
 *  - any other in_progress stage → failed (the disk is in an indeterminate
 *    state; the user must start over).
 *  - pending stages are left untouched (they never ran, no work lost) — the
 *    frontend hides the Cancel button when any stage is failed, so the user
 *    sees only the Start Over path.
 */
function rehydrateJob(): Job | null {
  let raw: string;
  try {
    raw = readFileSync(JOB_FILE, "utf8");
  } catch {
    return null;
  }
  let job: Job;
  try {
    job = JSON.parse(raw) as Job;
  } catch (err) {
    console.error("[jobs] Corrupt job file, discarding:", err);
    try { unlinkSync(JOB_FILE); } catch { /* ignore */ }
    return null;
  }

  if (job.status !== "in_progress") return job;

  const message = "Interrupted by addon restart";
  let interrupted = false;

  for (const stage of Object.values(job.stages)) {
    if (stage.status === "completed" || stage.status === "failed") continue;
    if (stage.name === "sandbox") {
      stage.status = "completed";
      stage.progress = 100;
      stage.description = message;
      continue;
    }
    if (stage.status === "in_progress") {
      stage.status = "failed";
      stage.description = message;
      interrupted = true;
    }
  }

  if (interrupted) {
    job.status = "failed";
    job.error = message;
  } else if (Object.values(job.stages).every((s) => s.status === "completed")) {
    // Only sandbox was in-flight and every other stage finished.
    job.status = "completed";
  } else {
    // in_progress job with nothing in-flight (e.g. persisted between createJob
    // and the first updateStage). No work to recover from — surface as failed.
    job.status = "failed";
    job.error = message;
  }
  return job;
}

let currentJob: Job | null = rehydrateJob();
// Persist any reconciled state so subsequent restarts don't re-run the transform.
if (currentJob) persist();

const subscribers = new Set<(msg: WsMessage) => void>();

function persist(): void {
  if (currentJob) {
    Bun.write(JOB_FILE, JSON.stringify(currentJob)).catch((err) => {
      console.error("[jobs] Failed to persist job:", err);
    });
  }
}

function unpersist(): void {
  try { unlinkSync(JOB_FILE); } catch { /* file may not exist */ }
}

export function getCurrentJob(): Job | null {
  return currentJob;
}

export function isLocked(): boolean {
  return currentJob !== null && currentJob.status === "in_progress";
}

/** Create a new clone job. Throws if a job is already in progress. */
export function createJob(
  device: Device,
  skipFlash?: boolean,
  sandboxEnabled?: boolean,
  mode: JobMode = "clone",
): Job {
  if (isLocked()) {
    throw new Error("A clone operation is already in progress.");
  }

  // For sandbox-only mode, the non-sandbox stages start as completed (skipped) —
  // there's no work for them to do.
  const skipped = (name: StageName): StageState => ({
    name,
    status: "completed",
    progress: 100,
    description: "Skipped (sandbox-only mode)",
  });
  const pending = (name: StageName): StageState => ({ name, status: "pending", progress: 0 });
  const stage = mode === "sandbox_only" ? skipped : pending;

  currentJob = {
    id: crypto.randomUUID().slice(0, 8),
    status: "in_progress",
    device,
    stages: {
      backup: stage("backup"),
      download: stage("download"),
      flash: stage("flash"),
      inject: stage("inject"),
      sandbox: { name: "sandbox", status: "pending", progress: 0 },
    },
    error: null,
    backupName: null,
    createdAt: Date.now(),
    skipFlash,
    sandboxEnabled,
    mode,
  };

  persist();
  return currentJob;
}

/** Update a stage's progress. Broadcasts to all WebSocket subscribers. */
export function updateStage(
  stage: StageName,
  status: StageStatus,
  progress: number,
  speed?: number,
  eta?: number,
  description?: string,
): void {
  if (!currentJob) return;
  currentJob.stages[stage] = {
    name: stage,
    status,
    progress,
    ...(description != null && { description }),
    ...(speed != null && { speed }),
    ...(eta != null && { eta }),
  };
  persist();
  broadcast({ type: "stage_update", stage, status, progress, speed, eta, description });
}

/** Store the backup name on the current job (for frontend display). */
export function setBackupName(name: string): void {
  if (!currentJob) return;
  currentJob.backupName = name;
  persist();
}

/** Mark the entire job as completed. */
export function completeJob(): void {
  if (!currentJob) return;
  currentJob.status = "completed";
  persist();
  broadcast({ type: "done", backupName: currentJob.backupName });
}

/** Mark the job as failed with an error message scoped to a stage. */
export function failJob(stage: StageName, message: string): void {
  if (!currentJob) return;
  currentJob.status = "failed";
  currentJob.error = message;
  currentJob.stages[stage].status = "failed";
  persist();
  broadcast({ type: "error", stage, message });
}

/** Clear the current job (used by cancel). Broadcasts cancellation. */
export function clearJob(): void {
  if (!currentJob) return;
  currentJob = null;
  unpersist();
  broadcast({ type: "cancelled" });
}

/** Dismiss a finished job without broadcasting (used by "Start Over"). */
export function dismissJob(): void {
  currentJob = null;
  unpersist();
}

/** Subscribe to job updates. Returns an unsubscribe function. */
export function subscribe(cb: (msg: WsMessage) => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

function broadcast(msg: WsMessage): void {
  for (const cb of subscribers) {
    try {
      cb(msg);
    } catch {
      /* ignore dead subscribers */
    }
  }
}
