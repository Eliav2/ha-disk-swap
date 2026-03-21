import { unlinkSync } from "node:fs";
import type { Device, Job, StageName, StageStatus, WsMessage } from "../shared/types.ts";

const JOB_FILE = "/data/current_job.json";

// --- State ---
let currentJob: Job | null = (() => {
  try {
    const raw = Bun.file(JOB_FILE).textSync();
    const job = JSON.parse(raw) as Job;
    // Sandbox can't survive an addon restart — mark it completed so the UI
    // doesn't try to show a dead iframe after a redeploy/restart.
    if (job.stages.sandbox?.status === "in_progress") {
      job.stages.sandbox.status = "completed";
      job.stages.sandbox.progress = 100;
      delete (job.stages.sandbox as any).description;
    }
    // If everything including sandbox is now complete, mark job completed.
    if (job.status === "in_progress" && Object.values(job.stages).every((s) => s.status === "completed")) {
      job.status = "completed";
    }
    return job;
  } catch {
    return null;
  }
})();

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
export function createJob(device: Device, skipFlash?: boolean, sandboxEnabled?: boolean): Job {
  if (isLocked()) {
    throw new Error("A clone operation is already in progress.");
  }

  currentJob = {
    id: crypto.randomUUID().slice(0, 8),
    status: "in_progress",
    device,
    stages: {
      backup: { name: "backup", status: "pending", progress: 0 },
      download: { name: "download", status: "pending", progress: 0 },
      flash: { name: "flash", status: "pending", progress: 0 },
      inject: { name: "inject", status: "pending", progress: 0 },
      sandbox: { name: "sandbox", status: "pending", progress: 0 },
    },
    error: null,
    backupName: null,
    createdAt: Date.now(),
    skipFlash,
    sandboxEnabled,
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
  currentJob.stages[stage] = { name: stage, status, progress, ...(description != null && { description }) };
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
