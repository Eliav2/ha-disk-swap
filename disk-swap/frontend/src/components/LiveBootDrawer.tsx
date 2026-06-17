import { useEffect, useState, useRef } from "react";
import { useStore } from "@tanstack/react-store";
import { Rocket, X, CheckCircle2, AlertTriangle, Loader2, ExternalLink } from "lucide-react";

import { appStore } from "@/store";
import { Button, buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerDescription,
} from "@/components/ui/drawer";
import { signalSandboxDone } from "@/lib/api";
import { useSandboxReady } from "@/hooks/use-sandbox-ready";
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
  const [doneClicked, setDoneClicked] = useState(false);

  const [overlayDismissed, setOverlayDismissed] = useState(false);

  const sandboxStage = stages.find((s) => s.name === "sandbox");
  const desc = sandboxStage?.description ?? "";
  const statusMsg = desc.startsWith("sandbox_status:") ? desc.slice(15) : null;

  // Sandbox lifecycle states, derived from the WS stage description:
  //   sandbox_status:… → still booting the inner Supervisor/Core
  //   sandbox_restoring → restore triggered, HA Core restarting
  //   sandbox_verifying → inspecting the restored instance (onboarded?)
  //   sandbox_ready     → restore VERIFIED — this is the user's HA
  //   sandbox_restore_failed → couldn't verify; offer manual restore
  const restoreFailed = desc === "sandbox_restore_failed";
  const verifiedReady = desc === "sandbox_ready";
  const restoring = desc === "sandbox_restoring";
  const verifying = desc === "sandbox_verifying";
  const loading = statusMsg != null;
  // Terminal = the run reached a final state and we surface a footer action.
  const terminal = verifiedReady || restoreFailed;

  // The drawer is available whenever the sandbox stage is in flight or terminal.
  // We don't unmount on completion — the user may still want to click "Done".
  const sandboxActive =
    sandboxStage?.status === "in_progress" &&
    (statusMsg != null || restoring || verifying || verifiedReady || restoreFailed);

  // True once the inner HA Core proxy is actually serving (iframe can load).
  const proxyReady = useSandboxReady(sandboxActive);

  // Auto-open the drawer as soon as the iframe is reachable and the run is
  // restoring/verifying/terminal, so the user watches the restore happen and
  // sees the result — including on repeat runs where liveState carried over.
  // Reset the latch when the sandbox stage ends so the next run re-arms.
  const autoOpenedRef = useRef(false);
  useEffect(() => {
    if (!sandboxActive) {
      autoOpenedRef.current = false;
      return;
    }
    const shouldShow = proxyReady && (restoring || verifying || terminal);
    if (shouldShow && !autoOpenedRef.current) {
      autoOpenedRef.current = true;
      if (liveState !== "open") setLiveState("open");
    }
  }, [sandboxActive, restoring, verifying, terminal, proxyReady, liveState, setLiveState]);

  if (!sandboxActive) return null;

  // During a restore the inner HA restarts; the iframe's document needs a hard
  // reload to pick up the post-restore HA, otherwise it sticks on whatever it
  // had during onboarding (often the "Welcome!" page). Bumping a cache-bust
  // tied to a terminal state flips the URL exactly once at the transition.
  const sandboxUrl = `http://${window.location.hostname}:8124/${terminal ? `?ts=ready` : ""}`;
  const drawerOpen = liveState === "open";
  const showSuccessDialog = verifiedReady && !overlayDismissed;
  const showFailureDialog = restoreFailed && !overlayDismissed;

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
          <Badge
            variant="outline"
            className={
              restoreFailed
                ? "border-red-400 text-red-600 text-[10px] px-1.5 py-0"
                : verifiedReady
                  ? "border-green-500 text-green-600 text-[10px] px-1.5 py-0"
                  : "border-amber-400 text-amber-600 text-[10px] px-1.5 py-0"
            }
          >
            {restoreFailed
              ? "action needed"
              : verifiedReady
                ? "restored"
                : verifying
                  ? "verifying"
                  : restoring
                    ? "restoring"
                    : loading
                      ? "booting"
                      : "live"}
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
                    ? "Restoring your backup automatically — the instance will restart momentarily."
                    : verifying
                      ? "Inspecting the restored instance to verify it came back correctly…"
                      : restoreFailed
                        ? "Automatic restore couldn't be verified — you can restore manually below."
                        : verifiedReady
                          ? "Your backup was restored and verified. Sandbox is isolated — it can't touch your real devices."
                          : "Sandbox is fully isolated — it cannot control your devices. Click Done when you're finished."}
              </DrawerDescription>
            </div>
            <div className="flex items-center gap-1">
              {/* Open the inner HA in a real top-level tab. The drawer iframe is a
                  cross-origin (:8124-in-:8123) third-party context, so browsers
                  that block third-party storage can't persist HA's session →
                  auth redirect loop / flicker. A first-party tab always works. */}
              {proxyReady && (
                <a
                  href={sandboxUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={buttonVariants({ variant: "ghost", size: "sm" })}
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  Open in new tab
                </a>
              )}
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setLiveState("min")}
                aria-label="Minimize live boot panel"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
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
              {/* Transparent progress overlay — iframe stays visible behind it
                  so the restore feels live, not hidden. */}
              {(loading || restoring || verifying) && proxyReady && (
                <div className="bg-background/70 absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center backdrop-blur-sm">
                  <Loader2 className="text-primary h-8 w-8 animate-spin" />
                  <p className="text-sm font-medium">
                    {loading
                      ? statusMsg
                      : restoring
                        ? "Restoring your backup…"
                        : "Verifying the restore…"}
                  </p>
                  <p className="text-muted-foreground max-w-sm text-xs">
                    {restoring
                      ? "Writing your configuration, automations, and history into the new instance."
                      : verifying
                        ? "Checking that Home Assistant came back fully onboarded with your data."
                        : "Booting an isolated Home Assistant against the new disk."}
                  </p>
                </div>
              )}

              {/* Success dialog — restore verified. */}
              {showSuccessDialog && proxyReady && (
                <div className="bg-background/90 absolute inset-0 flex flex-col items-center justify-center gap-4 px-6 text-center backdrop-blur-sm">
                  <CheckCircle2 className="h-12 w-12 text-green-500" />
                  <div className="space-y-1">
                    <p className="text-lg font-semibold">Backup restored & verified</p>
                    <p className="text-muted-foreground max-w-sm text-sm">
                      Home Assistant booted from the new disk with your configuration,
                      automations, history, add-ons and folders — and we confirmed it's
                      fully set up (no onboarding). Have a look, then shut the sandbox down.
                    </p>
                    <p className="text-muted-foreground/80 max-w-sm text-xs">
                      Note: the Disk Swap add-on itself isn't restored into the sandbox
                      (it can't run inside its own Live Boot) — it'll be there on your
                      real Home Assistant after the swap.
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Button variant="outline" onClick={() => setOverlayDismissed(true)}>
                      View Home Assistant
                    </Button>
                    <Button disabled={doneClicked} onClick={handleDone}>
                      {doneClicked ? "Shutting down…" : "Done — Shut down"}
                    </Button>
                  </div>
                </div>
              )}

              {/* Failure dialog — couldn't verify; guide manual restore. */}
              {showFailureDialog && proxyReady && (
                <div className="bg-background/90 absolute inset-0 flex flex-col items-center justify-center gap-4 px-6 text-center backdrop-blur-sm">
                  <AlertTriangle className="h-12 w-12 text-amber-500" />
                  <div className="space-y-1">
                    <p className="text-lg font-semibold">Automatic restore needs your help</p>
                    <p className="text-muted-foreground max-w-md text-sm">
                      We couldn't confirm the backup fully restored — Home Assistant may
                      still be showing onboarding. Open the instance below and restore your
                      backup manually: choose <span className="font-medium">“Restore from backup”</span>,
                      pick the most recent one, then come back and click Done.
                    </p>
                  </div>
                  <Button onClick={() => setOverlayDismissed(true)}>
                    Open Home Assistant to restore manually
                  </Button>
                </div>
              )}
            </div>
          </div>

          <div className="border-t p-4">
            {terminal ? (
              <Button
                className="w-full"
                variant={restoreFailed ? "outline" : "default"}
                disabled={doneClicked}
                onClick={handleDone}
              >
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
