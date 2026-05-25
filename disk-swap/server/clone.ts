import { statfsSync } from "node:fs";
import type { Device, Job, StageName } from "../shared/types.ts";
import { formatBytes } from "../shared/format.ts";
import {
  createJob,
  updateStage,
  completeJob,
  failJob,
  clearJob,
  setBackupName,
} from "./jobs.ts";
import {
  createFullBackup,
  pollJob,
  listBackups,
  getOsInfo,
  getInfo,
  machineToBoardSlug,
  getLastFullBackupSize,
} from "./supervisor.ts";
import {
  buildDownloadUrl,
  buildChecksumUrl,
  imagePath,
  downloadImage,
  verifyChecksum,
  isCachedImageValid,
  cleanupImage,
} from "./images.ts";
import { flash, runPartprobe } from "./flasher.ts";
import { injectBackup } from "./injector.ts";
import { runSandboxStage, awaitSandboxDone } from "./sandbox.ts";

const isDev = process.env.DEV === "1";
const MIN_DOWNLOAD_SPACE = 600 * 1024 * 1024; // 600 MB

// Pipeline context — module-level since only one clone runs at a time
let backupSlug = "";
let boardSlug = "";
let machineName = ""; // raw machine name (e.g. "qemuarm-64") used for HA Core Docker image
let osVersion = "";
let localImagePath = "";

// Cancellation support
let abortController: AbortController | null = null;
let activeProc: ReturnType<typeof Bun.spawn> | null = null;

class CancelledError extends Error {
  constructor() {
    super("Clone cancelled");
    this.name = "CancelledError";
  }
}

function checkCancelled(): void {
  if (abortController?.signal.aborted) throw new CancelledError();
}

/** Cancel the running clone pipeline. */
export function cancelClone(): void {
  abortController?.abort();
  abortController = null;
  try {
    activeProc?.kill();
  } catch { /* already exited */ }
  activeProc = null;
  clearJob();
  // Reset module-level context
  backupSlug = "";
  machineName = "";
  boardSlug = "";
  osVersion = "";
  localImagePath = "";
}

/** Pre-flight checks. Returns the validated Device. Throws on failure. */
async function preflight(
  devicePath: string,
  existingBackupSlug?: string,
): Promise<Device> {
  if (!isDev) {
    const stat = statfsSync("/data");
    const freeBytes = stat.bfree * stat.bsize;
    if (freeBytes < MIN_DOWNLOAD_SPACE) {
      const freeMB = Math.round(freeBytes / 1024 / 1024);
      throw new Error(
        `Not enough disk space for image download. Need ~600 MB, only ${freeMB} MB free.`,
      );
    }
  }

  const { listUsbDevices } = isDev
    ? await import("./mock.ts")
    : await import("./devices.ts");

  const devices = await listUsbDevices();
  const target = devices.find((d) => d.path === devicePath);
  if (!target) {
    throw new Error(
      `Target device ${devicePath} not found or is not a safe USB target.`,
    );
  }

  // Sanity check: the target device must fit the backup plus HA OS partition
  // overhead. Without this, the pipeline fails at inject-time with a confusing
  // ENOSPC while writing the backup tar into the (small) data partition.
  if (!isDev) {
    let backupBytes = 0;
    try {
      if (existingBackupSlug) {
        const backups = await listBackups();
        backupBytes = backups.find((b) => b.slug === existingBackupSlug)?.size_bytes ?? 0;
      } else {
        backupBytes = (await getLastFullBackupSize()) ?? 0;
      }
    } catch (err) {
      console.warn("[preflight] Backup size lookup failed, skipping size check:", err);
    }
    const overheadBytes = 2 * 1024 ** 3; // HA OS boot/EFI/state partitions ~1.5 GB + headroom
    const required = backupBytes + overheadBytes;
    if (backupBytes > 0 && target.size < required) {
      const requiredGB = (required / 1024 ** 3).toFixed(1);
      throw new Error(
        `Device ${target.size_human} is too small. Backup needs ~${requiredGB} GB ` +
          `(${formatBytes(backupBytes)} backup + 2 GB HA OS overhead). Use a larger USB device.`,
      );
    }
  }

  return target;
}

/**
 * Run ONLY the sandbox stage against a device that already has HA OS. Skips the
 * backup/download/flash/inject stages entirely — used for testing sandbox.ts
 * changes without a 20+ minute clone cycle.
 *
 * No backup auto-restore is attempted (backupSlug is empty); the user sees
 * either the existing data partition's HA (if one was injected previously) or
 * a fresh onboarding screen.
 */
export async function runSandboxOnlyPipeline(devicePath: string): Promise<Job> {
  const device = await preflight(devicePath);
  if (!device.has_ha_os) {
    throw new Error(
      `Sandbox-only mode requires a device with HA OS already flashed. ${devicePath} doesn't appear to.`,
    );
  }

  const job = createJob(device, true, true, "sandbox_only");

  // Reset module-level pipeline context so any leftover state from a previous
  // (clone) run doesn't leak in.
  backupSlug = "";
  boardSlug = "";
  machineName = "";
  osVersion = "";
  localImagePath = "";

  abortController = new AbortController();

  (async () => {
    try {
      // The sandbox stage needs the host's machine name to pick the HA Core image.
      if (isDev) {
        machineName = "rpi4-64";
      } else {
        const info = await getInfo();
        machineName = info.machine;
      }
      checkCancelled();
      console.log("[sandbox-only] Starting sandbox stage…");
      await runSandboxStage_pipeline(devicePath);
      completeJob();
      console.log("[sandbox-only] Pipeline completed.");
    } catch (err) {
      if (err instanceof CancelledError) {
        console.log("[sandbox-only] Cancelled.");
        return;
      }
      if (job.status === "in_progress") {
        failJob("sandbox", String(err));
      }
      console.error("[sandbox-only] Failed:", err);
    } finally {
      abortController = null;
      activeProc = null;
    }
  })();

  return job;
}

/** Run the full clone pipeline. Returns the job immediately; runs stages async. */
export async function runClonePipeline(
  devicePath: string,
  existingBackupSlug?: string,
  skipFlash?: boolean,
  skipSandbox?: boolean,
): Promise<Job> {
  const device = await preflight(devicePath, existingBackupSlug);
  const job = createJob(device, skipFlash, !skipSandbox);

  // Reset module-level pipeline context. Without this, a previous failed run
  // (not cancelled — cancelClone resets them) leaks stale values into the new
  // pipeline, e.g. skipFlash inherits the prior run's boardSlug/osVersion.
  backupSlug = "";
  boardSlug = "";
  machineName = "";
  osVersion = "";
  localImagePath = "";

  abortController = new AbortController();

  // Fire-and-forget — progress goes via WebSocket
  (async () => {
    try {
      if (existingBackupSlug) {
        // Use existing backup — skip backup stage
        backupSlug = existingBackupSlug;
        console.log("[clone] Using existing backup:", backupSlug);
        updateStage("backup", "completed", 100);
      } else {
        console.log("[clone] Starting backup stage...");
        await runBackupStage();
      }
      // Look up backup name for frontend display. In DEV mode the Supervisor
      // API isn't reachable (no SUPERVISOR_TOKEN); fall back to the mock.
      try {
        const { listBackups: listBackupsFn } = isDev
          ? await import("./mock.ts")
          : await import("./supervisor.ts");
        const backups = await listBackupsFn();
        const match = backups.find((b) => b.slug === backupSlug);
        if (match) setBackupName(match.name);
      } catch (err) {
        // Non-fatal — the UI just won't show the human-readable name.
        console.warn("[clone] Backup name lookup failed:", err);
      }
      checkCancelled();

      if (skipFlash) {
        // Device already has HA OS — skip download and flash, but still need machine name
        console.log("[clone] Skipping download and flash (device already has HA OS).");
        if (!isDev) {
          const info = await getInfo();
          machineName = info.machine;
        } else {
          machineName = "rpi4-64";
        }
        updateStage("download", "completed", 100);
        updateStage("flash", "completed", 100);
      } else {
        console.log("[clone] Starting download stage...");
        await runDownloadStage();
        checkCancelled();
        console.log("[clone] Starting flash stage...");
        await runFlashStage(devicePath);
      }
      checkCancelled();
      console.log("[clone] Starting inject stage...");
      await runInjectStage(devicePath);
      checkCancelled();
      if (skipSandbox) {
        console.log("[clone] Skipping sandbox stage (not enabled by user).");
        updateStage("sandbox", "completed", 100);
      } else {
        console.log("[clone] Starting sandbox stage...");
        await runSandboxStage_pipeline(devicePath);
      }
      completeJob();
      console.log("[clone] Pipeline completed successfully!");
    } catch (err) {
      if (err instanceof CancelledError) {
        console.log("[clone] Pipeline cancelled.");
        return;
      }
      if (job.status === "in_progress") {
        const active = findActiveStage(job);
        failJob(active, String(err));
      }
      console.error("[clone] Pipeline failed:", err);
    } finally {
      abortController = null;
      activeProc = null;
    }
  })();

  return job;
}

async function runSandboxStage_pipeline(devicePath: string): Promise<void> {
  updateStage("sandbox", "in_progress", 0);

  if (isDev) {
    // Emit the same status descriptions a real sandbox run would, so the UI's
    // LiveBootDrawer is exercised end-to-end in dev mode. Keep the timings
    // short so we don't drag the dev iteration loop out.
    const script: Array<[number, string]> = [
      [10, "sandbox_status:Pulling HA Supervisor image…"],
      [30, "sandbox_status:Setting up HA network…"],
      [60, "sandbox_status:Waiting for HA Core…"],
      [85, "sandbox_status:Waiting for Supervisor (boot cycle 1/2, ~10 min remaining)…"],
      [99, "sandbox_ready"],
    ];
    for (const [pct, desc] of script) {
      checkCancelled();
      await new Promise((r) => setTimeout(r, 500));
      updateStage("sandbox", "in_progress", pct, undefined, undefined, desc);
    }
    // Hold the "ready" state until the user clicks Done (or cancels) — mirrors
    // real-mode behaviour where the inner HA stays up until signalSandboxDone()
    // fires from POST /api/sandbox-done (drawer's "Done" button).
    await Promise.race([
      awaitSandboxDone(),
      new Promise<void>((resolve) => {
        abortController?.signal.addEventListener("abort", () => resolve(), { once: true });
      }),
    ]);
    updateStage("sandbox", "completed", 100);
    return;
  }

  try {
    await runSandboxStage(devicePath, machineName, backupSlug, (percent, description) => {
      updateStage("sandbox", "in_progress", percent, undefined, undefined, description);
    }, abortController!.signal);
    updateStage("sandbox", "completed", 100);
  } catch (err) {
    // If the user cancelled, let the outer pipeline handle it — clearJob() has
    // already wiped state, so updateStage would be a no-op anyway, but skip the
    // failure messaging to avoid confusing log output.
    if (err instanceof Error && err.message === "Cancelled") return;
    // Sandbox is non-fatal: the cloned disk is fully usable without it. Mark
    // the stage as failed (so the UI is honest about what happened) but DO NOT
    // re-throw — the outer pipeline still calls completeJob() and the user gets
    // the Next button to proceed to the swap instructions.
    console.warn("[sandbox] Stage failed (non-fatal):", err);
    updateStage(
      "sandbox",
      "failed",
      0,
      undefined,
      undefined,
      "Sandbox failed — disk is still usable. Verify your backup after first boot.",
    );
  }
}

function findActiveStage(job: Job): StageName {
  for (const name of ["backup", "download", "flash", "inject", "sandbox"] as StageName[]) {
    if (job.stages[name].status === "in_progress") return name;
  }
  return "backup";
}

// --- Individual Stage Runners ---

async function runBackupStage(): Promise<void> {
  updateStage("backup", "in_progress", 0);

  if (isDev) {
    for (let p = 0; p <= 100; p += 20) {
      checkCancelled();
      await new Promise((r) => setTimeout(r, 300));
      updateStage("backup", "in_progress", Math.min(p, 99));
    }
    backupSlug = "mock-backup-slug";
    updateStage("backup", "completed", 100);
    return;
  }

  try {
    // Snapshot existing files in /backup/ so we can detect the new one
    const existingFiles = new Set<string>();
    try {
      for (const entry of new Bun.Glob("*.tar").scanSync("/backup")) {
        existingFiles.add(entry);
      }
    } catch { /* /backup/ may not exist yet */ }

    // Get expected size from the most recent full backup
    const expectedSize = await getLastFullBackupSize();
    console.log("[backup] Expected size:", expectedSize);

    console.log("[backup] Creating full backup via Supervisor API...");
    const { job_id } = await createFullBackup();
    console.log("[backup] Backup job created:", job_id);

    while (true) {
      checkCancelled();
      await new Promise((r) => setTimeout(r, 2000));
      const status = await pollJob(job_id);

      if (status.errors?.length > 0) {
        throw new Error(`Backup failed: ${status.errors.join(", ")}`);
      }

      // Track progress via file size growth
      let progress = Math.round(status.progress);
      if (expectedSize && expectedSize > 0) {
        try {
          let newFileSize = 0;
          for (const entry of new Bun.Glob("*.tar").scanSync("/backup")) {
            if (!existingFiles.has(entry)) {
              const stat = Bun.file(`/backup/${entry}`);
              newFileSize = Math.max(newFileSize, stat.size);
            }
          }
          if (newFileSize > 0) {
            progress = Math.min(Math.round((newFileSize / expectedSize) * 100), 99);
          }
        } catch { /* ignore stat errors */ }
      }

      console.log("[backup] Poll: done=%s progress=%d fileProgress=%d", status.done, status.progress, progress);
      updateStage("backup", "in_progress", progress);

      if (status.done) {
        backupSlug = status.reference || "";
        console.log("[backup] Done. Slug:", backupSlug);
        if (!backupSlug) {
          throw new Error("Backup completed but no slug returned.");
        }
        if (!(await Bun.file(`/backup/${backupSlug}.tar`).exists())) {
          throw new Error(`Backup file /backup/${backupSlug}.tar not found.`);
        }
        updateStage("backup", "completed", 100);
        return;
      }
    }
  } catch (err) {
    if (err instanceof CancelledError) throw err;
    console.error("[backup] Failed:", err);
    throw err;
  }
}

async function runDownloadStage(): Promise<void> {
  updateStage("download", "in_progress", 0);

  try {
    if (isDev) {
      machineName = "rpi4-64";
      boardSlug = "rpi4-64";
      osVersion = "17.1";
    } else {
      const [info, osInfo] = await Promise.all([getInfo(), getOsInfo()]);
      machineName = info.machine;
      boardSlug = machineToBoardSlug(info.machine);
      osVersion = osInfo.version;
    }

    const imageUrl = buildDownloadUrl(boardSlug, osVersion);
    const checksumUrl = buildChecksumUrl(imageUrl);
    localImagePath = imagePath(boardSlug, osVersion);

    if (isDev) {
      // Mock download
      for (let p = 0; p <= 100; p += 10) {
        checkCancelled();
        await new Promise((r) => setTimeout(r, 200));
        updateStage("download", "in_progress", Math.min(p, 99));
      }
      updateStage("download", "completed", 100);
      return;
    }

    // Check cached image
    if (await isCachedImageValid(localImagePath, checksumUrl)) {
      console.log("Using cached image (checksum valid).");
      updateStage("download", "completed", 100, undefined, undefined, "Used cached image");
      return;
    }

    checkCancelled();
    const signal = abortController?.signal;
    await downloadImage(imageUrl, localImagePath, (percent, speed, eta) => {
      updateStage("download", "in_progress", percent, speed, eta);
    }, signal);

    await verifyChecksum(localImagePath, checksumUrl);
    updateStage("download", "completed", 100);
  } catch (err) {
    if (err instanceof CancelledError) throw err;
    cleanupImage(localImagePath);
    throw err;
  }
}

async function runFlashStage(devicePath: string): Promise<void> {
  updateStage("flash", "in_progress", 0);

  try {
    if (isDev) {
      for (let p = 0; p <= 100; p += 5) {
        checkCancelled();
        await new Promise((r) => setTimeout(r, 200));
        updateStage("flash", "in_progress", Math.min(p, 99));
      }
      updateStage("flash", "completed", 100);
      return;
    }

    await flash(localImagePath, devicePath, (percent, speed, eta) => {
      updateStage("flash", "in_progress", percent, speed, eta);
    }, abortController?.signal);

    await runPartprobe(devicePath);
    updateStage("flash", "completed", 100);

    // Clean up downloaded image to free space
    cleanupImage(localImagePath);
  } catch (err) {
    if (err instanceof CancelledError) throw err;
    throw err;
  }
}

async function runInjectStage(devicePath: string): Promise<void> {
  updateStage("inject", "in_progress", 0);

  try {
    if (isDev) {
      for (let p = 0; p <= 100; p += 25) {
        checkCancelled();
        await new Promise((r) => setTimeout(r, 200));
        updateStage("inject", "in_progress", Math.min(p, 99));
      }
      updateStage("inject", "completed", 100);
      return;
    }

    await injectBackup(devicePath, backupSlug, (percent, description, speed, eta) => {
      updateStage("inject", "in_progress", percent, speed, eta, description);
    }, abortController?.signal);

    updateStage("inject", "completed", 100);
  } catch (err) {
    if (err instanceof CancelledError) throw err;
    throw err;
  }
}
