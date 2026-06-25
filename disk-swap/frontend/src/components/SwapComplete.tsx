import type { Device } from "@/types";
import { useStore } from "@tanstack/react-store";
import { CheckCircle2 } from "lucide-react";
import { appStore } from "@/store";
import { useSystemInfo } from "@/hooks/use-system-info";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

interface SwapCompleteProps {
  device: Device;
  backupName: string | null;
  onReset: () => void;
}

export function SwapComplete({ device, backupName, onReset }: SwapCompleteProps) {
  const { data: systemInfo } = useSystemInfo();
  // True when the Live Boot stage restored AND verified the backup into the clone
  // (Core + apps + folders). Then the swapped disk needs no manual restore step.
  const restoreConfirmed = useStore(appStore, (s) => s.restoreConfirmed);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Clone Complete</h1>
        <p className="text-muted-foreground text-sm">
          {restoreConfirmed ? (
            <>
              Your Home Assistant was cloned and fully restored onto {device.vendor}{" "}
              {device.model}.
            </>
          ) : (
            <>HA OS has been cloned to {device.vendor} {device.model}.</>
          )}
        </p>
      </div>

      {/* Section 1: Boot from cloned device */}
      <Card>
        <CardHeader>
          <CardTitle>Boot from cloned device</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <ol className="list-inside list-decimal space-y-2">
            <li>Shut down your Home Assistant device.</li>
            <li>Remove the current boot media (SD card).</li>
            <li>
              Insert the cloned USB device (
              <strong>
                {device.vendor} {device.model}
              </strong>
              ).
            </li>
            <li>Power on and wait for HA to boot (~5 minutes).</li>
            <li>
              Log in with your existing credentials
              {systemInfo?.ip_address && (
                <>
                  {" "}at{" "}
                  <strong>http://{systemInfo.ip_address}:8123</strong>
                </>
              )}
              .
            </li>
          </ol>
          <p className="text-muted-foreground text-xs">
            {restoreConfirmed
              ? "Your configuration, automations, history, apps and folders are already restored — the disk boots straight into your Home Assistant."
              : "Your configuration, automations, and history are automatically restored on first boot."}
          </p>
        </CardContent>
      </Card>

      {/* Section 2: restore state — confirmed vs manual fallback */}
      {restoreConfirmed ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-green-500" />
              Apps already restored
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p className="text-muted-foreground">
              We booted the cloned disk and verified the restore: your add-ons,
              folders, configuration and history are all in place. No extra steps —
              it&apos;s ready to swap.
            </p>
            <p className="text-muted-foreground text-xs">
              One exception: the Disk Swap add-on itself isn&apos;t restored into the
              clone (it can&apos;t run inside its own Live Boot). Reinstall it from the
              add-on store afterwards if you want it on the cloned machine.
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Restore your backup</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p className="text-muted-foreground">
              The Live Boot restore didn&apos;t run or wasn&apos;t verified, so restore
              your backup on first boot:
            </p>
            <ol className="list-inside list-decimal space-y-2">
              <li>
                On first boot, choose <strong>Restore from backup</strong> on the
                welcome screen.
              </li>
              <li>
                Select the backup
                {backupName ? (
                  <> named <strong>"{backupName}"</strong></>
                ) : null}{" "}
                (already injected on the disk).
              </li>
              <li>Pick what to restore (full restore = identical machine).</li>
              <li>Wait for it to download and install.</li>
            </ol>
            <p className="text-muted-foreground text-xs">
              After restoring, your Home Assistant will be fully identical to the
              original.
            </p>
          </CardContent>
        </Card>
      )}

      <Button variant="outline" className="w-full" onClick={onReset}>
        Start New Clone
      </Button>
    </div>
  );
}
