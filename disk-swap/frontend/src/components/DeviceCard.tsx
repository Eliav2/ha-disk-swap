import type { Device } from "@/types";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Rocket } from "lucide-react";
import { cn } from "@/lib/utils";

interface DeviceCardProps {
  device: Device;
  selected: boolean;
  onSelect: () => void;
  /** Sandbox-only test mode trigger. Only shown when device.has_ha_os. */
  onTestLiveBoot?: () => void;
}

export function DeviceCard({ device, selected, onSelect, onTestLiveBoot }: DeviceCardProps) {
  return (
    <Card
      size="sm"
      className={cn(
        "cursor-pointer transition-colors",
        selected ? "ring-primary ring-2" : "hover:bg-muted/50",
      )}
      onClick={onSelect}
    >
      <CardContent>
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="font-medium">
                {device.vendor} {device.model}
              </span>
              <Badge variant="secondary">{device.size_human}</Badge>
              {device.has_ha_os && <Badge variant="outline">HA OS</Badge>}
            </div>
            <p className="text-muted-foreground text-xs">
              {device.path} &middot; {device.serial}
            </p>
          </div>
          {device.has_ha_os && onTestLiveBoot && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onTestLiveBoot();
              }}
              className="text-muted-foreground hover:text-foreground inline-flex shrink-0 items-center gap-1 text-xs underline-offset-2 hover:underline"
              title="Fast sanity check (~5 min): boot the cloned OS in the sandbox WITHOUT restoring a backup — confirms the disk boots. No clone, no flash, no restore."
            >
              <Rocket className="h-3 w-3" />
              Test Live Boot
            </button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
