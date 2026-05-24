import { useEffect, useState } from "react";
import { useStore } from "@tanstack/react-store";
import { useQuery } from "@tanstack/react-query";
import type { Device, StageState } from "@/types";
import { ExternalLink } from "lucide-react";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StageRow } from "@/components/StageRow";
import { cancelClone, signalSandboxDone, fetchLogs, fetchSandboxReady } from "@/lib/api";
import { actions, appStore } from "@/store";
import { useSystemInfo } from "@/hooks/use-system-info";

interface CloneProgressProps {
  device: Device;
  stages: StageState[];
}

export function CloneProgress({ device, stages }: CloneProgressProps) {
  const [cancelling, setCancelling] = useState(false);
  const [sandboxDone, setSandboxDone] = useState(false);
  const [sandboxReachable, setSandboxReachable] = useState(false);
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

  // Sandbox-only mode: the only stage rendered is `sandbox`. Adjust the page
  // header so users in test-mode don't see "Cloning…" — nothing is being cloned.
  const isSandboxOnly = stages.length === 1 && stages[0].name === "sandbox";

  const sandboxStage = stages.find((s) => s.name === "sandbox");
  const sandboxDesc = sandboxStage?.status === "in_progress" ? (sandboxStage.description ?? "") : "";
  // Parse sandbox_status:message descriptions for the status bar
  const sandboxStatusMsg = sandboxDesc.startsWith("sandbox_status:") ? sandboxDesc.slice(15) : null;
  // Show the sandbox panel once the proxy is up (sandbox_status:*, restoring, done, or failed)
  const isSandboxVisible = sandboxStage?.status === "in_progress" &&
    (sandboxStatusMsg != null || sandboxDesc === "sandbox_ready" || sandboxDesc === "sandbox_restoring" || sandboxDesc === "sandbox_restore_failed");
  const isSandboxRestoreFailed = sandboxDesc === "sandbox_restore_failed";
  const isSandboxReady = sandboxDesc === "sandbox_ready" || isSandboxRestoreFailed;
  const isSandboxRestoring = sandboxDesc === "sandbox_restoring";
  const isSandboxLoading = sandboxStatusMsg != null;

  const sandboxUrl = `http://${window.location.hostname}:8124/`;

  // Same-origin readiness probe — asks the addon backend whether the sandbox
  // proxy is wired up. Replaced the previous cross-origin `:8124/` probe which
  // suffered from (a) variable inner-HA response times triggering aborts and
  // (b) Chrome's negative-cache holding `ERR_ADDRESS_UNREACHABLE` open for
  // ~30s whenever the macOS↔UTM bridge briefly drops connectivity.
  useEffect(() => {
    if (!isSandboxVisible || sandboxReachable) return;
    let cancelled = false;
    const probe = async () => {
      const ready = await fetchSandboxReady();
      if (!cancelled && ready) setSandboxReachable(true);
    };
    probe();
    const id = setInterval(probe, 2000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [isSandboxVisible, sandboxReachable]);

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

      {isSandboxVisible && (
        <Card>
          <CardHeader>
            <CardTitle>
              {isSandboxOnly ? "Inner HA Core" : "Your new HA OS is running in parallel"}
            </CardTitle>
            <CardDescription>
              {isSandboxLoading
                ? sandboxStatusMsg
                : isSandboxRestoring
                  ? "Your backup is being restored automatically. The instance will restart momentarily."
                  : isSandboxOnly
                    ? "Test instance booted against the device's existing data partition. Click Done to shut it down. The inner HA is fully isolated — it cannot control your devices."
                    : "Verify everything looks correct, then click Done to proceed with the disk swap. This instance is fully isolated — it cannot control your devices."}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="relative w-full rounded-md overflow-hidden border" style={{ height: "600px" }}>
              {sandboxReachable ? (
                <iframe
                  src={sandboxUrl}
                  className="w-full h-full"
                  title="Home Assistant (new disk)"
                  sandbox="allow-same-origin allow-scripts allow-forms allow-popups"
                />
              ) : (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-muted">
                  <div className="h-8 w-8 rounded-full border-4 border-primary border-t-transparent animate-spin" />
                  <p className="text-sm text-muted-foreground">Connecting to sandbox instance…</p>
                </div>
              )}
              {(isSandboxLoading || isSandboxRestoring) && sandboxReachable && (
                <div className="absolute inset-0 bg-background/80 backdrop-blur-sm flex flex-col items-center justify-center gap-3">
                  <div className="h-8 w-8 rounded-full border-4 border-primary border-t-transparent animate-spin" />
                  <p className="text-sm font-medium">{isSandboxLoading ? sandboxStatusMsg : "Restoring your backup…"}</p>
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

      {!isFinished && !isSandboxReady && !hasFailed && (
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
