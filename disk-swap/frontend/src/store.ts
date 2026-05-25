import { Store } from "@tanstack/react-store";
import type { BackupSelection, Device, Job, StageState, SystemInfoResponse } from "@/types";
import { clearCurrentJob } from "@/lib/api";

/** Non-navigation app state. Routing lives in the URL (see routes.tsx). */
export interface AppState {
  selectedDevice: Device | null;
  selectedBackup: BackupSelection | null;
  backupName: string | null;
  skipFlash: boolean;
  sandboxEnabled: boolean;
  stages: StageState[];
  isJobDone: boolean;
  /** True while the initial fetchCurrentJob check is in-flight (suppresses
   *  device-picker flash before a redirect to /clone). */
  isCheckingJob: boolean;
}

const defaultStages: StageState[] = [
  { name: "backup", label: "Backup", description: "", status: "pending", progress: 0 },
  { name: "download", label: "Download HA OS image", description: "", status: "pending", progress: 0 },
  { name: "flash", label: "Flash to device", description: "", status: "pending", progress: 0 },
  { name: "inject", label: "Inject backup", description: "", status: "pending", progress: 0 },
];

export const appStore = new Store<AppState>({
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

  /** Called when navigating into /setup/$device. Defaults skipFlash based on
   *  whether the device already has HA OS; the user can still flip it on the
   *  setup page's Reflash switch. */
  prepareSetup() {
    appStore.setState((s) => ({
      ...s,
      skipFlash: s.selectedDevice?.has_ha_os ?? false,
    }));
  },

  /** Called when navigating from /setup back to /. Clears setup choices. */
  resetSetup() {
    appStore.setState((s) => ({
      ...s,
      selectedBackup: null,
      skipFlash: false,
      sandboxEnabled: true,
    }));
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

  /** Initialize stage list + reset isJobDone before kicking off the clone API call. */
  startClone(systemInfo?: SystemInfoResponse | null) {
    appStore.setState((s) => {
      const backup = s.selectedBackup ?? { type: "new" as const };
      return {
        ...s,
        isJobDone: false,
        stages: buildStages(backup, systemInfo, s.skipFlash, s.sandboxEnabled),
      };
    });
  },

  /** Sandbox-only test mode: bind the device, build a single-stage view, and
   *  let the caller navigate to /test/$device. */
  startSandboxOnly(device: Device) {
    appStore.setState(() => ({
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

  updateStage(stageName: string, status: StageState["status"], progress: number, speed?: number, eta?: number, description?: string) {
    appStore.setState((s) => ({
      ...s,
      stages: s.stages.map((st) =>
        st.name === stageName ? { ...st, status, progress, speed, eta, ...(description != null && { description }) } : st
      ),
    }));
  },

  doneCheckingJob() {
    appStore.setState((s) => ({ ...s, isCheckingJob: false }));
  },

  /** WS "done" message arrived — pipeline is finished. */
  finishJob(backupName?: string | null) {
    appStore.setState((s) => ({
      ...s,
      isJobDone: true,
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
