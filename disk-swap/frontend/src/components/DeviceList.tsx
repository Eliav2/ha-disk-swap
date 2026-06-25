import { RefreshCw, ShieldAlert, ExternalLink } from "lucide-react";
import type { Device } from "@/types";
import { useDevices } from "@/hooks/use-devices";
import { useSystemInfo } from "@/hooks/use-system-info";
import { DeviceCard } from "@/components/DeviceCard";
import { SystemInfo } from "@/components/SystemInfo";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";

interface DeviceListProps {
  selectedDevice: Device | null;
  onSelect: (device: Device) => void;
  onNext: () => void;
  /** Sandbox-only test mode (skip clone pipeline, just boot the inner HA). */
  onTestLiveBoot: (device: Device) => void;
}

export function DeviceList({ selectedDevice, onSelect, onNext, onTestLiveBoot }: DeviceListProps) {
  const { data: devices, isLoading, error, refetch, isFetching } = useDevices();
  const { data: systemInfo } = useSystemInfo();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Disk Swap
          {systemInfo?.addon_version && (
            <span className="text-muted-foreground ml-2 text-xs font-normal">v{systemInfo.addon_version}</span>
          )}
        </h1>
        <p className="text-muted-foreground text-sm">
          Clone your Home Assistant OS to a USB device.
        </p>
      </div>

      {systemInfo && <SystemInfo info={systemInfo} />}

      {systemInfo?.protected && (
        <div className="rounded-lg border border-amber-500/50 bg-amber-50 p-4 dark:bg-amber-950/30">
          <div className="flex items-start gap-3">
            <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
            <div className="space-y-2">
              <p className="text-sm font-medium text-amber-800 dark:text-amber-200">
                Protection Mode Enabled
              </p>
              <p className="text-sm text-amber-700 dark:text-amber-300">
                Disk Swap needs protection mode disabled to access USB devices for flashing.
              </p>
              <a
                href={`http://${systemInfo.ip_address}:8123/config/app/${systemInfo.addon_slug}/info`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-sm font-medium text-amber-700 underline underline-offset-2 hover:text-amber-900 dark:text-amber-300 dark:hover:text-amber-100"
              >
                Open Disk Swap settings
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
              <p className="text-xs text-amber-600 dark:text-amber-400">
                Toggle <strong>Protection mode</strong> off, then restart the app.
              </p>
            </div>
          </div>
        </div>
      )}

      <div>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-medium">Select a USB device</h2>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => refetch()}
          >
            <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
          </Button>
        </div>

        {isLoading && (
          <p className="text-muted-foreground text-sm">Scanning for devices...</p>
        )}

        {error && (
          <p className="text-destructive text-sm">
            Failed to load devices: {String(error)}
          </p>
        )}

        {!isLoading && !error && devices?.length === 0 && <EmptyState />}

        {devices && devices.length > 0 && (
          <div className="space-y-2">
            {devices.map((device) => (
              <DeviceCard
                key={device.path}
                device={device}
                selected={selectedDevice?.path === device.path}
                onSelect={() => onSelect(device)}
                onTestLiveBoot={() => onTestLiveBoot(device)}
              />
            ))}
          </div>
        )}
      </div>

      <Button
        className="w-full"
        disabled={!selectedDevice || systemInfo?.protected}
        onClick={onNext}
      >
        Next
      </Button>
    </div>
  );
}
