import { useState } from "react";
import { useStore } from "@tanstack/react-store";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { Device, StageState } from "@/types";
import { ExternalLink } from "lucide-react";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StageRow } from "@/components/StageRow";
import { cancelClone, clearCurrentJob, signalSandboxDone, fetchLogs } from "@/lib/api";
import { actions, appStore } from "@/store";
import { useSystemInfo } from "@/hooks/use-system-info";
import { useSandboxReady } from "@/hooks/use-sandbox-ready";
import { useLiveDrawerState } from "@/routes";

interface CloneProgressProps {
  device: Device;
  stages: StageState[];
}

export function CloneProgress({ device, stages }: CloneProgressProps) {
  const [cancelling, setCancelling] = useState(false);
  const navigate = useNavigate();
  const [, setLiveState] = useLiveDrawerState();
  const isJobDone = useStore(appStore, (s) => s.isJobDone);
  const { data: systemInfo } = useSystemInfo();
  const logsUrl = systemInfo?.addon_slug
    ? `/config/app/${systemInfo.addon_slug}/logs`
    : undefined;

  const activeStage = stages.find((s) => s.status === "in_progress");
  const isWriting = activeStage?.name === "flash" || activeStage?.name === "inject";
  const hasFailed = stages.some((s) => s.status === "failed");

  // The Live Boot row only becomes a clickable "Open" affordance once the inner
  // HA proxy is actually reachable — not during the earlier image-pull/boot
  // phases where opening the drawer would just show a "connecting" spinner.
  const sandboxStage = stages.find((s) => s.name === "sandbox");
  const sandboxReady = useSandboxReady(sandboxStage?.status === "in_progress");
  const isFinished = stages.every(
    (s) => s.status === "completed" || s.status === "failed",
  );
  // The sandbox stage parks at progress 99 / status "in_progress" while the user
  // inspects the inner HA (it only "completes" on Done), so `isFinished` never
  // flips during sandbox_ready. Treat the terminal sandbox descriptions as done
  // for polling — otherwise the log tail hammers /api/logs forever.
  const sandboxDesc = sandboxStage?.description ?? "";
  const sandboxTerminal =
    sandboxDesc === "sandbox_ready" || sandboxDesc === "sandbox_restore_failed";

  // Sandbox-only mode: the only stage rendered is `sandbox`. Adjust the header
  // since nothing is being cloned. The Live Boot iframe lives in
  // <LiveBootDrawer /> at the app root — not in this view.
  const isSandboxOnly = stages.length === 1 && stages[0].name === "sandbox";

  const { data: logLines = [] } = useQuery({
    queryKey: ["logs"],
    queryFn: () => fetchLogs(3),
    refetchInterval: isFinished || sandboxTerminal ? false : 2000,
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

  // Universal escape hatch for any terminal state (finished, sandbox_ready,
  // failed). Clears the PERSISTED job so a refresh doesn't re-trap the UI on a
  // completed run, and tells a still-live sandbox to tear down. Without this a
  // completed sandbox-only job leaves the view with no button at all.
  async function handleDiscard() {
    setCancelling(true);
    try {
      if (isSandboxOnly) await signalSandboxDone();
    } catch {
      /* sandbox may already be gone — ignore */
    }
    try {
      await clearCurrentJob();
    } catch {
      /* clearing is best-effort */
    }
    actions.reset();
    navigate({ to: "/" });
  }

  // A finished/terminal run that ISN'T the clone→swap success path (which has
  // its own "Next" button) must still offer a way back to the start.
  const isTerminal = isFinished || sandboxTerminal || hasFailed;
  const showDiscard = isTerminal && !(isJobDone && !isSandboxOnly);

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
            <StageRow
              key={stage.name}
              stage={stage}
              logsUrl={logsUrl}
              // The Live Boot (sandbox) row opens the drawer — but only once the
              // inner HA proxy is reachable, so "Open" doesn't show during boot.
              onClick={
                stage.name === "sandbox" && stage.status === "in_progress" && sandboxReady
                  ? () => setLiveState("open")
                  : undefined
              }
            />
          ))}
        </CardContent>
      </Card>

      {!isTerminal && (
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

      {/* Universal escape from any terminal state (sandbox done, finished, or
          failed). Always clears the persisted job so a refresh can't re-trap. */}
      {showDiscard && (
        <Button
          variant={hasFailed ? "outline" : "default"}
          className="w-full"
          disabled={cancelling}
          onClick={handleDiscard}
        >
          {cancelling
            ? "Closing…"
            : isSandboxOnly
              ? "Done — Close test"
              : hasFailed
                ? "Start Over"
                : "Done"}
        </Button>
      )}
    </div>
  );
}
