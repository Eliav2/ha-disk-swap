import type { Device, SupervisorBackup } from "../shared/types.ts";

/** Mock USB devices for local development */
export async function listUsbDevices(): Promise<Device[]> {
  return [
    {
      name: "sda",
      path: "/dev/sda",
      size: 32_000_000_000,
      size_human: "30 GB",
      vendor: "SanDisk",
      model: "Ultra Fit",
      tran: "usb",
      serial: "FAKE001",
      has_ha_os: true,
    },
    {
      name: "sdb",
      path: "/dev/sdb",
      size: 64_000_000_000,
      size_human: "60 GB",
      vendor: "Samsung",
      model: "EVO Select",
      tran: "usb",
      serial: "FAKE002",
      has_ha_os: false,
    },
  ];
}

/** Mock backups for local development */
export async function listBackups(): Promise<SupervisorBackup[]> {
  return [
    {
      slug: "abc12345",
      name: "Full backup 2026-02-20",
      date: "2026-02-20T10:30:00+00:00",
      type: "full",
      size: 0.45,
      size_bytes: 471859200,
    },
    {
      slug: "def67890",
      name: "disk-swap-clone-2026-02-18",
      date: "2026-02-18T14:15:00+00:00",
      type: "full",
      size: 0.38,
      size_bytes: 398458880,
    },
  ];
}

/** Mock system info for local development */
export async function getSystemInfo() {
  return {
    machine: "raspberrypi4-64",
    board_slug: "rpi4-64",
    os_version: "17.1",
    os_version_latest: "17.1",
    ip_address: "192.168.1.100",
    free_space_bytes: 24_696_061_952,
    free_space_human: "23.0 GB",
    protected: false,
    addon_slug: "64504a20_disk-swap",
    addon_version: "1.0.1-dev10",
  };
}
