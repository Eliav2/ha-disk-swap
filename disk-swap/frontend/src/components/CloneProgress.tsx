import { useState } from "react";
import { useStore } from "@tanstack/react-store";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { Device, StageState } from "@/types";
import { ExternalLink } from "lucide-react";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StageRow } from "@/components/StageRow";
import { cancelClone, fetchLogs } from "@/lib/api";
import { actions, appStore } from "@/store";
import { useSystemInfo } from "@/hooks/use-system-info";

interface CloneProgressProps {
  device: Device;
  stages: StageState[];
}

export function CloneProgress({ device, stages }: CloneProgressProps) {
  const [cancelling, setCancelling] = useState(false);
  const navigate = useNavigate();
  const isJobDone = useStore(appStore, (s) => s.isJobDone);
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

  // Sandbox-only mode: the only stage rendered is `sandbox`. Adjust the header
  // since nothing is being cloned. The Live Boot iframe lives in
  // <LiveBootDrawer /> at the app root — not in this view.
  const isSandboxOnly = stages.length === 1 && stages[0].name === "sandbox";

  const { data: logLines = [] } = useQuery({
    queryKey: ["logs"],
    queryFn: () => fetchLogs(3),
    refetchInterval: isFinished ? false : 2000,
    staleTime: 1000,
  });

  async function handleCancel() {
    setCancelling(true);
    try {
      await cancelClone();
      actions.reset();
      navigate({ to: "/" });
    } catch {
      setCancelling(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          {isSandboxOnly ? "Testing Live Boot..." : "Cloning..."}
        </h1>
        <p className="text-muted-foreground text-sm">
          {isSandboxOnly
            ? <>Booting the inner HA against the existing data partition on {device.vendor} {device.model}. Do not unplug the device.</>
            : <>Writing to {device.vendor} {device.model} ({device.size_human}). Do not unplug the device.</>}
        </p>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Progress</CardTitle>
            {logsUrl && (
              <a
                href={logsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
              >
                Full logs
                <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </div>
          <CardDescription>{device.path}</CardDescription>
          {!isFinished && logLines.length > 0 && (
            <div className="mt-2 rounded bg-muted/50 px-3 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground overflow-hidden">
              {logLines.map((line, i) => (
                <div key={i} className="truncate">{line}</div>
              ))}
            </div>
          )}
        </CardHeader>
        <CardContent className="space-y-4">
          {stages.map((stage) => (
            <StageRow key={stage.name} stage={stage} logsUrl={logsUrl} />
          ))}
        </CardContent>
      </Card>

      {!isFinished && !hasFailed && (
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
            You can safely navigate away — {isSandboxOnly ? "the test runs" : "cloning continues"} in the background.
          </p>
        </>
      )}

      {isJobDone && !isSandboxOnly && (
        <Button className="w-full" onClick={() => navigate({ to: "/swap" })}>
          Next — Swap instructions
        </Button>
      )}

      {hasFailed && !isJobDone && (
        <Button
          variant="outline"
          className="w-full"
          onClick={() => {
            actions.reset();
            navigate({ to: "/" });
          }}
        >
          Start Over
        </Button>
      )}
    </div>
  );
}
