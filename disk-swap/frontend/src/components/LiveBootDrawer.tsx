import { useEffect, useState } from "react";
import { useStore } from "@tanstack/react-store";
import { Rocket, X } from "lucide-react";

import { appStore } from "@/store";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerDescription,
} from "@/components/ui/drawer";
import { fetchSandboxReady, signalSandboxDone } from "@/lib/api";
import { useLiveDrawerState } from "@/routes";

/**
 * Bottom-sheet drawer for the inner HA Core iframe. Mounts at the app root and
 * is available from any route. Visibility is gated on the sandbox stage state
 * coming through the global WS store; open/minimize is URL-driven via
 * `?live=open|min` so refresh and deep links preserve it.
 *
 * States:
 *   - sandbox stage not active → drawer hidden, no pill
 *   - active + `?live` missing → small floating pill bottom-right
 *   - active + `?live=open` → expanded drawer with iframe
 *   - active + `?live=min` → pill (explicit minimize)
 */
export function LiveBootDrawer() {
  const stages = useStore(appStore, (s) => s.stages);
  const [liveState, setLiveState] = useLiveDrawerState();
  const [proxyReady, setProxyReady] = useState(false);
  const [doneClicked, setDoneClicked] = useState(false);

  const sandboxStage = stages.find((s) => s.name === "sandbox");
  const desc = sandboxStage?.description ?? "";
  const statusMsg = desc.startsWith("sandbox_status:") ? desc.slice(15) : null;

  // The drawer is available whenever the sandbox stage is in flight or ready.
  // We don't unmount the drawer immediately on completion — the user may still
  // want to click "Done" from the iframe view.
  const sandboxActive =
    sandboxStage?.status === "in_progress" &&
    (statusMsg != null ||
      desc === "sandbox_ready" ||
      desc === "sandbox_restoring" ||
      desc === "sandbox_restore_failed");

  const restoreFailed = desc === "sandbox_restore_failed";
  const ready = desc === "sandbox_ready" || restoreFailed;
  const restoring = desc === "sandbox_restoring";
  const loading = statusMsg != null;

  // Probe whether the addon's sandbox proxy is wired up. Same-origin so it
  // sidesteps the macOS↔UTM bridge flakiness that broke the old cross-origin
  // probe. Stops once we've seen ready=true.
  useEffect(() => {
    if (!sandboxActive || proxyReady) return;
    let cancelled = false;
    const tick = async () => {
      const ok = await fetchSandboxReady();
      if (!cancelled && ok) setProxyReady(true);
    };
    tick();
    const id = setInterval(tick, 2000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [sandboxActive, proxyReady]);

  // Default to open when the iframe first becomes usable, so the user doesn't
  // miss the panel. After that, respect their open/min preference.
  useEffect(() => {
    if (ready && proxyReady && liveState === undefined) setLiveState("open");
  }, [ready, proxyReady, liveState, setLiveState]);

  if (!sandboxActive) return null;

  const sandboxUrl = `http://${window.location.hostname}:8124/`;
  const drawerOpen = liveState === "open";

  async function handleDone() {
    setDoneClicked(true);
    await signalSandboxDone();
  }

  return (
    <>
      {/* Floating pill (visible whenever the drawer is closed/minimized) */}
      {!drawerOpen && (
        <button
          type="button"
          onClick={() => setLiveState("open")}
          className="bg-background text-foreground ring-foreground/10 hover:bg-muted fixed right-4 bottom-4 inline-flex items-center gap-2 rounded-full px-3 py-2 text-xs font-medium shadow-lg ring-1 transition-colors"
        >
          <Rocket className="h-3.5 w-3.5" />
          <span>Live Boot</span>
          <Badge variant="outline" className="border-amber-400 text-amber-600 text-[10px] px-1.5 py-0">
            {ready ? "ready" : restoring ? "restoring" : loading ? "booting" : "live"}
          </Badge>
        </button>
      )}

      <Drawer
        direction="bottom"
        open={drawerOpen}
        onOpenChange={(open: boolean) => setLiveState(open ? "open" : "min")}
      >
        <DrawerContent className="data-[direction=bottom]:max-h-[85vh] data-[direction=bottom]:h-[85vh]">
          <DrawerHeader className="flex flex-row items-start justify-between gap-3">
            <div className="space-y-0.5 text-left">
              <DrawerTitle className="flex items-center gap-2">
                <Rocket className="h-4 w-4" /> Inner HA Core
                <Badge variant="outline" className="border-amber-400 text-amber-600 text-[10px] px-1.5 py-0">
                  Experimental
                </Badge>
              </DrawerTitle>
              <DrawerDescription>
                {loading
                  ? statusMsg
                  : restoring
                    ? "Your backup is being restored automatically. The instance will restart momentarily."
                    : restoreFailed
                      ? "Auto-restore failed — restore manually inside the iframe, then click Done."
                      : "Sandbox is fully isolated — it cannot control your devices. Click Done when you're finished."}
              </DrawerDescription>
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setLiveState("min")}
              aria-label="Minimize live boot panel"
            >
              <X className="h-4 w-4" />
            </Button>
          </DrawerHeader>

          <div className="relative flex-1 px-4 pb-4">
            <div className="relative h-full w-full overflow-hidden rounded-md border">
              {proxyReady ? (
                <iframe
                  src={sandboxUrl}
                  className="h-full w-full"
                  title="Home Assistant (sandbox)"
                  sandbox="allow-same-origin allow-scripts allow-forms allow-popups"
                />
              ) : (
                <div className="bg-muted absolute inset-0 flex flex-col items-center justify-center gap-3">
                  <div className="border-primary h-8 w-8 animate-spin rounded-full border-4 border-t-transparent" />
                  <p className="text-muted-foreground text-sm">Connecting to sandbox instance…</p>
                </div>
              )}
              {(loading || restoring) && proxyReady && (
                <div className="bg-background/80 absolute inset-0 flex flex-col items-center justify-center gap-3 backdrop-blur-sm">
                  <div className="border-primary h-8 w-8 animate-spin rounded-full border-4 border-t-transparent" />
                  <p className="text-sm font-medium">{loading ? statusMsg : "Restoring your backup…"}</p>
                </div>
              )}
            </div>
          </div>

          <div className="border-t p-4">
            {ready ? (
              <Button className="w-full" disabled={doneClicked} onClick={handleDone}>
                {doneClicked ? "Shutting down…" : "Done — Shut down sandbox"}
              </Button>
            ) : (
              <p className="text-muted-foreground text-center text-xs">
                You can keep working in the main panel — this drawer stays alive in the background.
              </p>
            )}
          </div>
        </DrawerContent>
      </Drawer>
    </>
  );
}
