import type { BackupSelection, Device } from "@/types";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
} from "@/components/ui/alert-dialog";

interface ConfirmDialogProps {
  device: Device;
  selectedBackup: BackupSelection | null;
  skipFlash: boolean;
  sandboxEnabled: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Final confirmation before starting the clone pipeline. Renders an accurate
 * description of the actions about to be performed, based on the user's choices
 * in BackupSelect — reflash on/off, new vs existing backup, sandbox enabled.
 */
export function ConfirmDialog({
  device,
  selectedBackup,
  skipFlash,
  sandboxEnabled,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const deviceLabel = `${device.vendor} ${device.model}`.trim() || device.path;
  // skipFlash=true means the device already has HA OS and we're only updating
  // the data partition. skipFlash=false means a full wipe + reflash.
  const title = skipFlash ? "Update data partition" : "Erase & clone";
  const primaryAction = skipFlash ? "Update & inject" : "Erase & clone";

  return (
    <AlertDialog open onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>
            {skipFlash ? (
              <>
                This will reformat the <strong>data partition</strong> on{" "}
                <strong>{deviceLabel}</strong> ({device.size_human}) and inject
                your backup. The HA OS itself is left in place, but any addons,
                snapshots, or app data already on the data partition will be lost.
              </>
            ) : (
              <>
                This will <strong>permanently erase</strong> all data on{" "}
                <strong>{deviceLabel}</strong> ({device.size_human}) and clone
                Home Assistant OS to it.
              </>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <ul className="text-muted-foreground sm:group-data-[size=default]/alert-dialog-content:text-left list-disc list-inside space-y-1 text-sm">
          <li>
            Backup:{" "}
            {selectedBackup?.type === "existing" ? (
              <>using existing backup <strong>"{selectedBackup.name}"</strong></>
            ) : (
              <>a new full backup will be created first</>
            )}
          </li>
          {sandboxEnabled && (
            <li>
              Live Boot: the cloned OS will boot in parallel for verification
              before you swap the disk (adds ~10–25 min)
            </li>
          )}
          <li>This action cannot be undone.</li>
        </ul>

        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onConfirm}>
            {primaryAction}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
