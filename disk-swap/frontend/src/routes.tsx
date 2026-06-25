import { useEffect } from "react";
import {
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  useNavigate,
  useParams,
  useSearch,
} from "@tanstack/react-router";
import { useStore } from "@tanstack/react-store";
import { useQueryClient } from "@tanstack/react-query";

import { actions, appStore } from "@/store";
import { useCloneProgress } from "@/hooks/use-clone-progress";
import { useSystemInfo } from "@/hooks/use-system-info";
import { useImageCache } from "@/hooks/use-image-cache";
import { useDevices } from "@/hooks/use-devices";
import { fetchCurrentJob, clearCurrentJob, startClone, startSandboxOnly } from "@/lib/api";
import { DeviceList } from "@/components/DeviceList";
import { BackupSelect } from "@/components/BackupSelect";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { CloneProgress } from "@/components/CloneProgress";
import { SwapComplete } from "@/components/SwapComplete";
import { LiveBootDrawer } from "@/components/LiveBootDrawer";

// Hash history: HA ingress mounts us under /api/hassio_ingress/<token>/, which
// changes per session and isn't preserved across refresh in a way TanStack
// Router's browser-history mode can reliably target. The `#/<path>` form
// sidesteps the ingress proxy entirely — hash changes never re-hit the server.
const history = createHashHistory();

// --- Root ----------------------------------------------------------------

const rootRoute = createRootRoute({
  component: RootLayout,
  validateSearch: (search): { live?: "open" | "min" } => ({
    live: search.live === "open" || search.live === "min" ? search.live : undefined,
  }),
});

function RootLayout() {
  const navigate = useNavigate();
  // Keep WS connected globally so the sandbox state survives navigation between
  // /clone and /clone/swap (or any route, really) without dropping the iframe.
  // On WS "cancelled", reset + return to the device picker.
  useCloneProgress(true, () => navigate({ to: "/" }));
  return (
    <>
      <div className="mx-auto max-w-2xl px-4 py-6">
        <Outlet />
      </div>
      <LiveBootDrawer />
    </>
  );
}

// --- / (device picker) ---------------------------------------------------

const deviceListRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: DeviceListPage,
});

function DeviceListPage() {
  const navigate = useNavigate();
  const selectedDevice = useStore(appStore, (s) => s.selectedDevice);
  const isCheckingJob = useStore(appStore, (s) => s.isCheckingJob);
  const { data: systemInfo } = useSystemInfo();
  useImageCache(); // keep cache warm

  // Resume in-flight job: if the backend has one, jump to /clone with state restored.
  useEffect(() => {
    fetchCurrentJob()
      .then((job) => {
        // Only resume a job that's still running. A persisted terminal job
        // (completed/failed — e.g. a finished sandbox-only Live Boot test) must
        // NOT route into the progress view: that view has no follow-up for it
        // and the user would be trapped with no way to start a new clone. Clear
        // the stale record and fall back to the device picker instead.
        if (job && job.status === "in_progress") {
          actions.resumeJob(job, systemInfo ?? null);
          navigate({ to: job.mode === "sandbox_only" ? "/test/$device" : "/clone", params: { device: job.device.path } });
        } else {
          if (job) clearCurrentJob().catch(() => {});
          actions.doneCheckingJob();
        }
      })
      .catch(() => actions.doneCheckingJob());
    // run once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (isCheckingJob) return null;

  return (
    <DeviceList
      selectedDevice={selectedDevice}
      onSelect={actions.selectDevice}
      onNext={() => {
        if (!selectedDevice) return;
        actions.prepareSetup();
        navigate({ to: "/setup/$device", params: { device: selectedDevice.path } });
      }}
      onTestLiveBoot={async (device) => {
        actions.startSandboxOnly(device);
        navigate({ to: "/test/$device", params: { device: device.path } });
        try {
          // "Test Live Boot" is a fast sanity check: boot the cloned OS WITHOUT
          // restoring (skips the ~20-min restore) — confirms the disk boots.
          await startSandboxOnly(device.path, true);
        } catch {
          /* WS reports stage errors */
        }
      }}
    />
  );
}

// --- /setup/$device (backup picker + toggles) ----------------------------

const setupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/setup/$device",
  component: SetupPage,
});

/** Hook: ensures `appStore.selectedDevice` matches the URL `device` param.
 *  If the store is empty (cold-refresh into /setup/...), look up the device
 *  from /api/devices. Returns the resolved Device or null while loading. */
function useDeviceFromUrl() {
  const { device } = useParams({ strict: false }) as { device?: string };
  const navigate = useNavigate();
  const selectedDevice = useStore(appStore, (s) => s.selectedDevice);
  const { data: devices } = useDevices();

  useEffect(() => {
    if (!device) return;
    // TanStack Router already URL-decoded the param.
    if (selectedDevice?.path === device) return;
    const match = devices?.find((d) => d.path === device);
    if (match) actions.selectDevice(match);
    // No match yet (devices still loading) — wait. If devices loaded and no
    // match, fall back to the device picker.
    else if (devices && devices.length > 0) navigate({ to: "/" });
  }, [device, devices, selectedDevice, navigate]);

  return selectedDevice;
}

function SetupPage() {
  const navigate = useNavigate();
  const device = useDeviceFromUrl();
  const selectedBackup = useStore(appStore, (s) => s.selectedBackup);
  const skipFlash = useStore(appStore, (s) => s.skipFlash);
  const sandboxEnabled = useStore(appStore, (s) => s.sandboxEnabled);

  if (!device) return <p className="text-muted-foreground text-sm">Loading device…</p>;

  return (
    <>
      <BackupSelect
        device={device}
        selectedBackup={selectedBackup}
        skipFlash={skipFlash}
        sandboxEnabled={sandboxEnabled}
        onSelect={actions.selectBackup}
        onSetSkipFlash={actions.setSkipFlash}
        onSetSandboxEnabled={actions.setSandboxEnabled}
        onNext={() =>
          navigate({
            to: "/setup/$device/confirm",
            params: { device: device.path },
          })
        }
        onBack={() => {
          actions.resetSetup();
          navigate({ to: "/" });
        }}
      />
      <Outlet />
    </>
  );
}

// --- /setup/$device/confirm (final confirm dialog) ----------------------

const confirmRoute = createRoute({
  getParentRoute: () => setupRoute,
  path: "confirm",
  component: ConfirmPage,
});

function ConfirmPage() {
  const navigate = useNavigate();
  const { device } = useParams({ from: "/setup/$device/confirm" });
  const selectedDevice = useStore(appStore, (s) => s.selectedDevice);
  const selectedBackup = useStore(appStore, (s) => s.selectedBackup);
  const skipFlash = useStore(appStore, (s) => s.skipFlash);
  const sandboxEnabled = useStore(appStore, (s) => s.sandboxEnabled);
  const { data: systemInfo } = useSystemInfo();

  if (!selectedDevice) return null;

  return (
    <ConfirmDialog
      device={selectedDevice}
      selectedBackup={selectedBackup}
      skipFlash={skipFlash}
      sandboxEnabled={sandboxEnabled}
      onCancel={() => navigate({ to: "/setup/$device", params: { device } })}
      onConfirm={async () => {
        actions.startClone(systemInfo ?? null);
        navigate({ to: "/clone" });
        try {
          const backupSlug =
            selectedBackup?.type === "existing" ? selectedBackup.slug : undefined;
          await startClone(selectedDevice.path, backupSlug, skipFlash, !sandboxEnabled);
        } catch {
          /* WS will report errors */
        }
      }}
    />
  );
}

// --- /clone (progress) ---------------------------------------------------

const cloneRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/clone",
  component: ClonePage,
});

// /swap lives as a sibling of /clone rather than a nested child — nesting would
// require ClonePage to render <Outlet /> and there's no useful parent-child UI
// relationship between the progress view and the post-swap instructions.

function ClonePage() {
  const selectedDevice = useStore(appStore, (s) => s.selectedDevice);
  const stages = useStore(appStore, (s) => s.stages);
  const queryClient = useQueryClient();

  useEffect(() => {
    // Refresh image-cache view once the pipeline starts — download stage may
    // create/discard the cached image.
    queryClient.invalidateQueries({ queryKey: ["image-cache"] });
  }, [queryClient]);

  if (!selectedDevice) return null;
  return <CloneProgress device={selectedDevice} stages={stages} />;
}

// --- /clone/swap (post-clone instructions) -------------------------------

const swapRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/swap",
  component: SwapPage,
});

function SwapPage() {
  const navigate = useNavigate();
  const selectedDevice = useStore(appStore, (s) => s.selectedDevice);
  const backupName = useStore(appStore, (s) => s.backupName);
  if (!selectedDevice) return null;
  return (
    <SwapComplete
      device={selectedDevice}
      backupName={backupName}
      onReset={() => {
        actions.reset();
        navigate({ to: "/" });
      }}
    />
  );
}

// --- /test/$device (sandbox-only) ----------------------------------------

const testRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/test/$device",
  component: TestPage,
});

function TestPage() {
  const device = useDeviceFromUrl();
  const stages = useStore(appStore, (s) => s.stages);
  if (!device) return <p className="text-muted-foreground text-sm">Loading device…</p>;
  return <CloneProgress device={device} stages={stages} />;
}

// --- Router instance -----------------------------------------------------

const routeTree = rootRoute.addChildren([
  deviceListRoute,
  setupRoute.addChildren([confirmRoute]),
  cloneRoute,
  swapRoute,
  testRoute,
]);

export const router = createRouter({ routeTree, history });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

/** Hook for any route that wants to read/write the `?live=open|min` drawer state. */
export function useLiveDrawerState() {
  const search = useSearch({ strict: false }) as { live?: "open" | "min" };
  const navigate = useNavigate();
  const setLive = (live: "open" | "min" | undefined) =>
    // `live` is the only registered search param at the root, so a flat
    // replacement is safe; using a reducer fn here trips TanStack Router's
    // type inference (Register-wide `never` for unknown route params).
    navigate({ to: ".", search: { live }, replace: true } as never);
  return [search.live, setLive] as const;
}
