import { $ } from "bun";
import type { RawBlockDevice, Device } from "../shared/types.ts";
import { formatBytes } from "../shared/format.ts";

/**
 * Determine the boot disk name (e.g. "mmcblk0" or "sda").
 * Uses findmnt to find the root mount source, then lsblk to get the parent disk.
 */
export async function getBootDisk(): Promise<string> {
  try {
    const rootSource = (
      await $`findmnt --noheadings --output SOURCE --target /`.text()
    ).trim();

    // In HA containers the root fs is often overlay — not a block device
    const result = await $`lsblk --noheadings --output PKNAME ${rootSource}`.nothrow().quiet();
    if (result.exitCode !== 0) return "";

    const pkname = result.text().trim();
    const diskName = pkname || rootSource;
    return diskName.replace("/dev/", "");
  } catch {
    // If anything fails, return empty — USB filter is the primary safety gate
    return "";
  }
}

/**
 * Safety filter: determine if a block device is a valid flash target.
 * - Must NOT be the boot disk
 * - Must be USB-connected
 * - Must be between 8 GB and 2 TB
 */
export function isSafeTarget(
  dev: RawBlockDevice,
  bootDisk: string
): boolean {
  if (dev.name === bootDisk) return false;
  if (dev.tran !== "usb") return false;

  const size = typeof dev.size === "string" ? parseInt(dev.size, 10) : dev.size;
  const MIN_SIZE = 8 * 1024 ** 3; // 8 GB
  const MAX_SIZE = 2 * 1024 ** 4; // 2 TB

  if (size < MIN_SIZE || size > MAX_SIZE) return false;

  return true;
}

/** Check if a device has HA OS by looking for hassos-boot GPT partition label. */
async function hasHaOs(devicePath: string): Promise<boolean> {
  try {
    const output = await $`lsblk -nro PARTLABEL ${devicePath}`.nothrow().quiet().text();
    return output.includes("hassos-boot");
  } catch {
    return false;
  }
}

/**
 * List all USB block devices that are safe flash targets.
 */
export async function listUsbDevices(): Promise<Device[]> {
  const bootDisk = await getBootDisk();

  const result =
    await $`lsblk --json -b -o NAME,SIZE,TYPE,TRAN,VENDOR,MODEL,SERIAL --nodeps`.nothrow().quiet();

  if (result.exitCode !== 0) {
    // lsblk can fail (exit 32) when no block devices are available
    return [];
  }

  const lsblkOutput = result.json();
  const rawDevices: RawBlockDevice[] = lsblkOutput.blockdevices ?? [];

  const safe = rawDevices.filter(
    (dev) => dev.type === "disk" && isSafeTarget(dev, bootDisk),
  );

  return Promise.all(
    safe.map(async (dev) => {
      const size =
        typeof dev.size === "string" ? parseInt(dev.size, 10) : dev.size;
      const path = `/dev/${dev.name}`;
      return {
        name: dev.name,
        path,
        size,
        size_human: formatBytes(size),
        vendor: (dev.vendor ?? "").trim(),
        model: (dev.model ?? "").trim(),
        tran: dev.tran ?? "unknown",
        serial: (dev.serial ?? "").trim(),
        has_ha_os: await hasHaOs(path),
      };
    }),
  );
}
