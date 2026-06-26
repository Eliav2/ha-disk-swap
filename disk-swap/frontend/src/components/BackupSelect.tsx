import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { useBackups } from "@/hooks/use-backups";
import { useImageCache } from "@/hooks/use-image-cache";
import { discardImageCache } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { BackupSelection, Device } from "@/types";
import { useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { ArrowLeft, ExternalLink, HardDrive, Plus, Rocket, Trash2, Usb } from "lucide-react";
import { useState } from "react";

interface BackupSelectProps {
  device: Device;
  selectedBackup: BackupSelection | null;
  skipFlash: boolean;
  sandboxEnabled: boolean;
  onSelect: (backup: BackupSelection) => void;
  onSetSkipFlash: (skip: boolean) => void;
  onSetSandboxEnabled: (enabled: boolean) => void;
  onNext: () => void;
  onBack: () => void;
}

function formatDate(dateStr: string): string {
  try {
    const date = new Date(dateStr);
    return formatDistanceToNow(date, { addSuffix: true });
  } catch {
    return dateStr;
  }
}

function formatSize(sizeMB: number): string {
  if (sizeMB >= 1024) return `${(sizeMB / 1024).toFixed(1)} GB`;
  return `${Math.round(sizeMB)} MB`;
}

export function BackupSelect({ device, selectedBackup, skipFlash, sandboxEnabled, onSelect, onSetSkipFlash, onSetSandboxEnabled, onNext, onBack }: BackupSelectProps) {
  const { data: backups, isLoading, error } = useBackups();
  const { data: imageCache } = useImageCache();
  const queryClient = useQueryClient();
  const [discarding, setDiscarding] = useState(false);

  const isNewSelected = selectedBackup?.type === "new";

  async function handleDiscard() {
    setDiscarding(true);
    try {
      await discardImageCache();
      queryClient.invalidateQueries({ queryKey: ["image-cache"] });
    } catch {
      // silently fail — next clone will just re-download
    } finally {
      setDiscarding(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Select Backup</h1>
        <p className="text-muted-foreground text-sm">
          Choose an existing backup or create a new one to include in the clone.
        </p>
      </div>

      <div className="space-y-2">
        {/* Create New Backup option */}
        <Card
          size="sm"
          className={cn(
            "cursor-pointer transition-colors",
            isNewSelected
              ? "ring-primary ring-2"
              : "hover:bg-muted/50",
          )}
          onClick={() => onSelect({ type: "new" })}
        >
          <CardContent>
            <div className="flex items-center gap-2">
              <Plus className="h-4 w-4" />
              <span className="font-medium">Create New Backup</span>
            </div>
            <p className="text-muted-foreground mt-1 text-xs">
              Creates a full backup of your HA configuration, apps, and database.
            </p>
          </CardContent>
        </Card>

        {/* Existing backups */}
        {isLoading && (
          <p className="text-muted-foreground text-sm">Loading backups...</p>
        )}

        {error && (
          <p className="text-destructive text-sm">
            Failed to load backups: {String(error)}
          </p>
        )}

        {backups && backups.length > 0 && (
          // p-1 inside the scroll container leaves room for the selected-card
          // ring-2 outline; without it the focus ring clips against the edges.
          <div className="max-h-80 space-y-2 overflow-y-auto p-1">
            {backups.map((backup) => {
              const isSelected =
                selectedBackup?.type === "existing" && selectedBackup.slug === backup.slug;
              return (
                <Card
                  key={backup.slug}
                  size="sm"
                  className={cn(
                    "cursor-pointer transition-colors",
                    isSelected
                      ? "ring-primary ring-2"
                      : "hover:bg-muted/50",
                  )}
                  onClick={() => onSelect({ type: "existing", slug: backup.slug, name: backup.name })}
                >
                  <CardContent>
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{backup.name}</span>
                        <Badge variant="secondary">{backup.type}</Badge>
                        <Badge variant="outline">{formatSize(backup.size)}</Badge>
                      </div>
                      <p className="text-muted-foreground text-xs">
                        {formatDate(backup.date)}
                      </p>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}

        {backups && backups.length === 0 && (
          <p className="text-muted-foreground text-sm">
            No existing backups found. Select "Create New Backup" above.
          </p>
        )}
      </div>

      <a
        href="/config/backup/backups"
        target="_blank"
        rel="noopener noreferrer"
        className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs transition-colors"
      >
        Manage backups in Settings
        <ExternalLink className="h-3 w-3" />
      </a>

      {/* Cached OS Image */}
      {imageCache?.cached && (
        <div className="space-y-2">
          <h2 className="text-sm font-medium">Cached OS Image</h2>
          <Card size="sm">
            <CardContent>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <HardDrive className="text-muted-foreground h-4 w-4" />
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">
                        HA OS {imageCache.version}
                      </span>
                      <Badge variant="secondary">cached</Badge>
                      <Badge variant="outline">{imageCache.size_human}</Badge>
                    </div>
                    <p className="text-muted-foreground text-xs">
                      Board: {imageCache.board} — download step will be skipped
                    </p>
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleDiscard}
                  disabled={discarding}
                >
                  <Trash2 className="mr-1 h-3.5 w-3.5" />
                  {discarding ? "Discarding..." : "Discard"}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Flash Status */}
      {device.has_ha_os && (
        <div className="space-y-2">
          <h2 className="text-sm font-medium">Flash Status</h2>
          <Card size="sm">
            <CardContent>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Usb className="text-muted-foreground h-4 w-4" />
                  <div>
                    <span className="text-sm font-medium">
                      Device already has HA OS
                    </span>
                    <p className="text-muted-foreground text-xs">
                      {skipFlash
                        ? "Flash and download steps will be skipped."
                        : "Device will be reflashed with a fresh image."}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <label htmlFor="reflash" className="text-xs whitespace-nowrap">
                    Reflash
                  </label>
                  <Switch
                    id="reflash"
                    checked={!skipFlash}
                    onCheckedChange={(checked) => onSetSkipFlash(!checked)}
                  />
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Live Boot (Experimental) */}
      <div className="space-y-2">
        <h2 className="text-sm font-medium">Live Boot</h2>
        <Card size="sm">
          <CardContent>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Rocket className="text-muted-foreground h-4 w-4" />
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">Restore into the new disk &amp; boot it live</span>
                    <Badge variant="outline" className="border-amber-400 text-amber-600 text-[10px] px-1.5 py-0">
                      Experimental
                    </Badge>
                  </div>
                  <p className="text-muted-foreground text-xs">
                    {sandboxEnabled
                      ? "Your full backup (Core, add-ons, folders, history) is restored into the new disk and the new HA OS boots live inside the add-on so you can confirm — so the disk comes up ready, no first-boot steps. The inner HA is fully isolated and cannot control your devices. Adds ~10–20 min."
                      : "Off: the backup is only copied onto the disk — you'll have to restore it manually (Restore from backup) on first boot. Enable to restore it now and boot the disk ready."}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <label htmlFor="sandbox-enable" className="text-xs whitespace-nowrap">
                  Enable
                </label>
                <Switch
                  id="sandbox-enable"
                  checked={sandboxEnabled}
                  onCheckedChange={onSetSandboxEnabled}
                />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="flex gap-2">
        <Button variant="outline" className="flex-1" onClick={onBack}>
          <ArrowLeft className="mr-1 h-4 w-4" />
          Back
        </Button>
        <Button
          className="flex-1"
          disabled={!selectedBackup}
          onClick={onNext}
        >
          Continue
        </Button>
      </div>
    </div>
  );
}
