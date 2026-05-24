import { Store } from "@tanstack/react-store";
import type { BackupSelection, Device, Job, Screen, StageState, SystemInfoResponse } from "@/types";
import { clearCurrentJob } from "@/lib/api";

export interface AppState {
  screen: Screen;
  selectedDevice: Device | null;
  selectedBackup: BackupSelection | null;
  backupName: string | null;
  skipFlash: boolean;
  sandboxEnabled: boolean;
  stages: StageState[];
  isJobDone: boolean;
  /** True while the initial fetchCurrentJob check is in-flight (suppresses device_select flash). */
  isCheckingJob: boolean;
}

const defaultStages: StageState[] = [
  { name: "backup", label: "Backup", description: "", status: "pending", progress: 0 },
  { name: "download", label: "Download HA OS image", description: "", status: "pending", progress: 0 },
  { name: "flash", label: "Flash to device", description: "", status: "pending", progress: 0 },
  { name: "inject", label: "Inject backup", description: "", status: "pending", progress: 0 },
];

export const appStore = new Store<AppState>({
  screen: "device_select",
  selectedDevice: null,
  selectedBackup: null,
  backupName: null,
  skipFlash: false,
  sandboxEnabled: true,
  stages: defaultStages,
  isJobDone: false,
  isCheckingJob: true,
});

/** Build stages with dynamic descriptions based on user selections and system info. */
function buildStages(
  backup: BackupSelection,
  systemInfo?: SystemInfoResponse | null,
  skipFlash?: boolean,
  sandboxEnabled?: boolean,
  mode: "clone" | "sandbox_only" = "clone",
): StageState[] {
  if (mode === "sandbox_only") {
    return [{
      name: "sandbox" as const,
      label: "Live Boot",
      description: "Boots the inner HA against the existing data partition. Sandbox-only test mode.",
      status: "pending" as const,
      progress: 0,
      experimental: true,
    }];
  }
  const version = systemInfo?.os_version ?? "latest";
  const board = systemInfo?.board_slug ?? "your device";
  const releaseUrl = `https://github.com/home-assistant/operating-system/releases/tag/${version}`;

  const downloadDesc = skipFlash
    ? "Skipped — device already has HA OS."
    : `Downloads HA OS ${version} for ${board}.`;

  const downloadLabel = skipFlash
    ? "Download HA OS image (skipped)"
    : "Download HA OS image";

  return [
    {
      name: "backup",
      label: "Backup",
      description: backup.type === "new"
        ? "Creates a full backup of your HA configuration, apps, and database."
        : `Using existing backup "${backup.name}".`,
      status: "pending",
      progress: 0,
    },
    {
      name: "download",
      label: downloadLabel,
      description: downloadDesc,
      link: skipFlash ? undefined : { text: "View release", url: releaseUrl },
      status: "pending",
      progress: 0,
    },
    {
      name: "flash",
      label: skipFlash ? "Flash to device (skipped)" : "Flash to device",
      description: skipFlash
        ? "Skipped — device already has HA OS."
        : "Writes the OS image to the target USB device.",
      status: "pending",
      progress: 0,
    },
    {
      name: "inject",
      label: "Inject backup",
      description: "Copies backup to the new device for automatic restore on first boot.",
      status: "pending",
      progress: 0,
    },
    ...(sandboxEnabled ? [{
      name: "sandbox" as const,
      label: "Live Boot",
      description: "Boots your new HA OS in parallel — verify your backup restored correctly before you swap the disk.",
      status: "pending" as const,
      progress: 0,
      experimental: true,
    }] : []),
  ];
}

export const actions = {
  selectDevice(device: Device) {
    appStore.setState((s) => ({ ...s, selectedDevice: device }));
  },

  /** From device_select, go directly to backup_select. The confirm dialog is now
   * the LAST step (after toggles are chosen) so its copy can be accurate. */
  next() {
    appStore.setState((s) => ({
      ...s,
      screen: "backup_select" as const,
      // Default skipFlash based on whether the device already has HA OS — the
      // user can still flip it from the Reflash switch on backup_select.
      skipFlash: s.selectedDevice?.has_ha_os ?? false,
    }));
  },

  /** From backup_select, open the final confirm dialog. */
  openConfirm() {
    appStore.setState((s) => ({ ...s, screen: "confirm" as const }));
  },

  /** Cancel the confirm dialog — return to backup_select to allow toggling. */
  closeConfirm() {
    appStore.setState((s) => ({ ...s, screen: "backup_select" as const }));
  },

  selectBackup(backup: BackupSelection) {
    appStore.setState((s) => ({ ...s, selectedBackup: backup }));
  },

  setSkipFlash(skip: boolean) {
    appStore.setState((s) => ({ ...s, skipFlash: skip }));
  },

  setSandboxEnabled(enabled: boolean) {
    appStore.setState((s) => ({ ...s, sandboxEnabled: enabled }));
  },

  /** Start the pipeline after backup is selected. */
  startClone(systemInfo?: SystemInfoResponse | null) {
    appStore.setState((s) => {
      const backup = s.selectedBackup ?? { type: "new" as const };
      return {
        ...s,
        screen: "progress" as const,
        isJobDone: false,
        stages: buildStages(backup, systemInfo, s.skipFlash, s.sandboxEnabled),
      };
    });
  },

  /** Sandbox-only test mode: jumps straight to the progress screen with only the
   *  sandbox stage. No backup/download/flash/inject. Triggered from the device
   *  card's "Test Live Boot" link when the device already has HA OS. */
  startSandboxOnly(device: Device) {
    appStore.setState(() => ({
      screen: "progress" as const,
      selectedDevice: device,
      selectedBackup: null,
      backupName: null,
      skipFlash: false,
      sandboxEnabled: true,
      isJobDone: false,
      isCheckingJob: false,
      stages: buildStages({ type: "new" }, null, false, true, "sandbox_only"),
    }));
  },

  /** Go back from backup_select to device_select. */
  backToDeviceSelect() {
    appStore.setState((s) => ({
      ...s,
      screen: "device_select" as const,
      selectedBackup: null,
      skipFlash: false,
      sandboxEnabled: true,
    }));
  },

  updateStage(stageName: string, status: StageState["status"], progress: number, speed?: number, eta?: number, description?: string) {
    appStore.setState((s) => ({
      ...s,
      stages: s.stages.map((st) =>
        st.name === stageName ? { ...st, status, progress, speed, eta, ...(description != null && { description }) } : st
      ),
    }));
  },

  /** Called once the initial fetchCurrentJob check completes (success or failure). */
  doneCheckingJob() {
    appStore.setState((s) => ({ ...s, isCheckingJob: false }));
  },

  /** Called when the WS "done" message arrives — marks job finished without navigating. */
  finishJob(backupName?: string | null) {
    appStore.setState((s) => ({
      ...s,
      isJobDone: true,
      backupName: backupName ?? s.backupName,
    }));
  },

  complete(backupName?: string | null) {
    appStore.setState((s) => ({
      ...s,
      screen: "complete" as const,
      backupName: backupName ?? s.backupName,
    }));
  },

  resumeJob(job: Job, systemInfo?: SystemInfoResponse | null) {
    const isCompleted = job.status === "completed";
    const skipFlash = job.skipFlash ?? false;
    const sandboxEnabled = job.sandboxEnabled ?? false;
    const mode = job.mode ?? "clone";

    const base = buildStages({ type: "new" }, systemInfo, skipFlash, sandboxEnabled, mode);
    const stages: StageState[] = base.map((init) => {
      const jobStage = job.stages[init.name];
      return {
        ...init,
        status: jobStage?.status ?? "pending",
        progress: jobStage?.progress ?? 0,
        ...(jobStage?.description && { description: jobStage.description }),
      };
    });

    appStore.setState(() => ({
      screen: "progress" as const,
      selectedDevice: job.device,
      selectedBackup: null,
      backupName: job.backupName,
      skipFlash,
      sandboxEnabled,
      stages,
      isJobDone: isCompleted,
      isCheckingJob: false,
    }));
  },

  reset() {
    clearCurrentJob().catch(() => {});
    appStore.setState(() => ({
      screen: "device_select" as const,
      selectedDevice: null,
      selectedBackup: null,
      backupName: null,
      skipFlash: false,
      sandboxEnabled: true,
      stages: defaultStages.map((st) => ({ ...st })),
      isJobDone: false,
      isCheckingJob: false,
    }));
  },
};
