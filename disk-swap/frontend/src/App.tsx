import { useEffect, useEffectEvent } from "react";
import { useStore } from "@tanstack/react-store";
import { appStore, actions } from "@/store";
import { useCloneProgress } from "@/hooks/use-clone-progress";
import { useSystemInfo } from "@/hooks/use-system-info";
import { useImageCache } from "@/hooks/use-image-cache";
import { fetchCurrentJob, startClone, startSandboxOnly } from "@/lib/api";
import type { Device } from "@/types";
import { DeviceList } from "@/components/DeviceList";
import { BackupSelect } from "@/components/BackupSelect";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { CloneProgress } from "@/components/CloneProgress";
import { SwapComplete } from "@/components/SwapComplete";

export default function App() {
  const screen = useStore(appStore, (s) => s.screen);
  const isCheckingJob = useStore(appStore, (s) => s.isCheckingJob);
  const selectedDevice = useStore(appStore, (s) => s.selectedDevice);
  const selectedBackup = useStore(appStore, (s) => s.selectedBackup);
  const backupName = useStore(appStore, (s) => s.backupName);
  const skipFlash = useStore(appStore, (s) => s.skipFlash);
  const sandboxEnabled = useStore(appStore, (s) => s.sandboxEnabled);
  const stages = useStore(appStore, (s) => s.stages);
  const { data: systemInfo } = useSystemInfo();
  useImageCache(); // keep query warm for image-cache UI components

  // useEffectEvent lets us read the latest systemInfo inside the effect without
  // making it a reactive dependency (avoids re-running when systemInfo refetches).
  const onJobFetched = useEffectEvent((job: Parameters<typeof actions.resumeJob>[0]) => {
    actions.resumeJob(job, systemInfo);
  });

  // On initial load or after returning to device_select, check for an in-progress
  // or completed job and restore it. Guard prevents re-running while already showing
  // progress (which would overwrite live WS stage updates with stale persisted state).
  useEffect(() => {
    if (screen !== "device_select") return;
    fetchCurrentJob()
      .then((job) => {
        if (job) onJobFetched(job);
        else actions.doneCheckingJob();
      })
      .catch(() => actions.doneCheckingJob());
  }, [screen]);

  useCloneProgress(screen === "progress");

  async function handleStart() {
    if (!selectedDevice) return;
    actions.startClone(systemInfo);
    const backupSlug =
      selectedBackup?.type === "existing" ? selectedBackup.slug : undefined;
    try {
      await startClone(selectedDevice.path, backupSlug, skipFlash, !sandboxEnabled);
    } catch {
      // WebSocket will report actual stage errors
    }
  }

  async function handleTestLiveBoot(device: Device) {
    actions.startSandboxOnly(device);
    try {
      await startSandboxOnly(device.path);
    } catch {
      // WebSocket will report stage errors
    }
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-6">
      {screen === "device_select" && !isCheckingJob && (
        <DeviceList
          selectedDevice={selectedDevice}
          onSelect={actions.selectDevice}
          onNext={actions.next}
          onTestLiveBoot={handleTestLiveBoot}
        />
      )}

      {screen === "backup_select" && selectedDevice && (
        <BackupSelect
          device={selectedDevice}
          selectedBackup={selectedBackup}
          skipFlash={skipFlash}
          sandboxEnabled={sandboxEnabled}
          onSelect={actions.selectBackup}
          onSetSkipFlash={actions.setSkipFlash}
          onSetSandboxEnabled={actions.setSandboxEnabled}
          onNext={actions.openConfirm}
          onBack={actions.backToDeviceSelect}
        />
      )}

      {screen === "confirm" && selectedDevice && (
        <ConfirmDialog
          device={selectedDevice}
          selectedBackup={selectedBackup}
          skipFlash={skipFlash}
          sandboxEnabled={sandboxEnabled}
          onConfirm={handleStart}
          onCancel={actions.closeConfirm}
        />
      )}

      {screen === "progress" && selectedDevice && (
        <CloneProgress device={selectedDevice} stages={stages} />
      )}

      {screen === "complete" && selectedDevice && (
        <SwapComplete
          device={selectedDevice}
          backupName={backupName}
          onReset={actions.reset}
        />
      )}
    </div>
  );
}
