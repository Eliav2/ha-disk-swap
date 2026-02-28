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

  // Sandbox is "ready" when the stage is in_progress with description "sandbox_ready"
  const sandboxStage = stages.find((s) => s.name === "sandbox");
  const isSandboxReady =
    sandboxStage?.status === "in_progress" && sandboxStage?.description === "sandbox_ready";

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

      {isSandboxReady && (
        <Card>
          <CardHeader>
            <CardTitle>Your new HA OS is running in parallel</CardTitle>
            <CardDescription>
              A live Home Assistant instance booted from your new disk is running inside the add-on.
              Complete onboarding, restore your backup, and verify everything looks correct.
              This is an isolated environment — it cannot control your devices or affect your running HA.
              Click Done when you're satisfied, then swap the disk.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <iframe
              src={`http://${window.location.hostname}:8124/`}
              className="w-full rounded-md border"
              style={{ height: "600px" }}
              title="Home Assistant (new disk)"
            />
            <Button
              className="w-full"
              disabled={sandboxDone}
              onClick={handleSandboxDone}
            >
              {sandboxDone ? "Shutting down…" : "Done — Ready to Swap Disk"}
            </Button>
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
