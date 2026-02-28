import { useState } from "react";
import { useStore } from "@tanstack/react-store";
import type { Device, StageState } from "@/types";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StageRow } from "@/components/StageRow";
import { cancelClone, signalSandboxDone } from "@/lib/api";
import { actions, appStore } from "@/store";
import { useSystemInfo } from "@/hooks/use-system-info";

interface CloneProgressProps {
  device: Device;
  stages: StageState[];
}

export function CloneProgress({ device, stages }: CloneProgressProps) {
  const [cancelling, setCancelling] = useState(false);
  const [sandboxDone, setSandboxDone] = useState(false);
  const isJobDone = useStore(appStore, (s) => s.isJobDone);
  const backupName = useStore(appStore, (s) => s.backupName);
  const { data: systemInfo } = useSystemInfo();
  const logsUrl = systemInfo?.addon_slug
    ? `/config/app/${systemInfo.addon_slug}/logs`
    : undefined;

  const activeStage = stages.find((s) => s.status === "in_progress");
  const isWriting = activeStage?.name === "flash" || activeStage?.name === "inject";
  const hasFailed = stages.some((s) => s.status === "failed");
  const isFinished = stages.every(
    (s) => s.status === "completed" || s.status === "failed",
  );

  const sandboxStage = stages.find((s) => s.name === "sandbox");
  const sandboxDesc = sandboxStage?.status === "in_progress" ? (sandboxStage.description ?? "") : "";
  // Show the sandbox panel once the iframe is ready (restoring, done, or failed)
  const isSandboxVisible = sandboxStage?.status === "in_progress" &&
    (sandboxDesc === "sandbox_ready" || sandboxDesc === "sandbox_restoring" || sandboxDesc === "sandbox_restore_failed" || (sandboxStage?.progress ?? 0) >= 85);
  const isSandboxRestoreFailed = sandboxDesc === "sandbox_restore_failed";
  const isSandboxReady = sandboxDesc === "sandbox_ready" || isSandboxRestoreFailed;
  const isSandboxRestoring = isSandboxVisible && !isSandboxReady;

  async function handleCancel() {
    setCancelling(true);
    try {
      await cancelClone();
      actions.reset();
    } catch {
      setCancelling(false);
    }
  }

  async function handleSandboxDone() {
    setSandboxDone(true);
    await signalSandboxDone();
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Cloning...</h1>
        <p className="text-muted-foreground text-sm">
          Writing to {device.vendor} {device.model} ({device.size_human}).
          Do not unplug the device.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Progress</CardTitle>
          <CardDescription>{device.path}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {stages.map((stage) => (
            <StageRow key={stage.name} stage={stage} logsUrl={logsUrl} />
          ))}
        </CardContent>
      </Card>

      {isSandboxVisible && (
        <Card>
          <CardHeader>
            <CardTitle>Your new HA OS is running in parallel</CardTitle>
            <CardDescription>
              {isSandboxRestoring
                ? "Your backup is being restored automatically. The instance will restart momentarily."
                : "Verify everything looks correct, then click Done to proceed with the disk swap. This instance is fully isolated — it cannot control your devices."}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="relative w-full rounded-md overflow-hidden border" style={{ height: "600px" }}>
              <iframe
                src={`http://${window.location.hostname}:8124/`}
                className="w-full h-full"
                title="Home Assistant (new disk)"
              />
              {isSandboxRestoring && (
                <div className="absolute inset-0 bg-background/80 backdrop-blur-sm flex flex-col items-center justify-center gap-3">
                  <div className="h-8 w-8 rounded-full border-4 border-primary border-t-transparent animate-spin" />
                  <p className="text-sm font-medium">{sandboxStage?.description && sandboxStage.description !== "sandbox_restoring" ? sandboxStage.description : "Restoring your backup…"}</p>
                </div>
              )}
            </div>
            {isSandboxRestoreFailed && (
              <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive space-y-1">
                <p className="font-medium">Auto-restore failed — please restore manually:</p>
                <ol className="list-decimal list-inside space-y-0.5 text-destructive/90">
                  <li>Complete onboarding in the panel above</li>
                  <li>Go to <strong>Settings → System → Backups</strong></li>
                  <li>Select your backup and click <strong>Restore</strong></li>
                  <li>Once restored, click the button below</li>
                </ol>
              </div>
            )}
            {isSandboxReady && (
              <Button
                className="w-full"
                disabled={sandboxDone}
                onClick={handleSandboxDone}
              >
                {sandboxDone ? "Shutting down…" : "Done — Ready to Swap Disk"}
              </Button>
            )}
          </CardContent>
        </Card>
      )}

      {!isFinished && !isSandboxReady && (
        <>
          <Button
            variant="outline"
            className="w-full"
            disabled={cancelling}
            onClick={handleCancel}
          >
            {cancelling
              ? "Cancelling..."
              : isWriting
                ? "Cancel (will interrupt write)"
                : "Cancel"}
          </Button>
          <p className="text-muted-foreground text-center text-xs">
            You can safely navigate away — cloning continues in the background.
          </p>
        </>
      )}

      {isJobDone && (
        <Button
          className="w-full"
          onClick={() => actions.complete(backupName)}
        >
          Next
        </Button>
      )}

      {hasFailed && !isJobDone && (
        <Button
          variant="outline"
          className="w-full"
          onClick={actions.reset}
        >
          Start Over
        </Button>
      )}
    </div>
  );
}
