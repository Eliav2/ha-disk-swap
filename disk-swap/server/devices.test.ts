import { describe, expect, test } from "bun:test";
import { isSafeTarget } from "./devices.ts";
import type { RawBlockDevice } from "../shared/types.ts";

// Make a RawBlockDevice with sane defaults; tests override only the field
// they're exercising.
function dev(overrides: Partial<RawBlockDevice> = {}): RawBlockDevice {
  return {
    name: "sda",
    size: 16 * 1024 ** 3,
    type: "disk",
    tran: "usb",
    vendor: "Test",
    model: "TestDisk",
    serial: "ABC",
    ...overrides,
  };
}

describe("isSafeTarget", () => {
  test("rejects boot disk even if otherwise valid", () => {
    expect(isSafeTarget(dev({ name: "mmcblk0" }), "mmcblk0")).toBe(false);
  });

  test("rejects non-USB transports (sata, nvme, mmc, null)", () => {
    expect(isSafeTarget(dev({ tran: "sata" }), "")).toBe(false);
    expect(isSafeTarget(dev({ tran: "nvme" }), "")).toBe(false);
    expect(isSafeTarget(dev({ tran: "mmc" }), "")).toBe(false);
    expect(isSafeTarget(dev({ tran: null }), "")).toBe(false);
  });

  test("rejects devices under 8 GB", () => {
    // 7.5 GB
    expect(isSafeTarget(dev({ size: 7.5 * 1024 ** 3 }), "")).toBe(false);
  });

  test("accepts devices at exactly 8 GB", () => {
    expect(isSafeTarget(dev({ size: 8 * 1024 ** 3 }), "")).toBe(true);
  });

  test("rejects devices over 2 TB", () => {
    expect(isSafeTarget(dev({ size: 3 * 1024 ** 4 }), "")).toBe(false);
  });

  test("accepts a typical 16 GB USB", () => {
    expect(isSafeTarget(dev(), "")).toBe(true);
  });

  test("accepts string-typed size (lsblk output quirk)", () => {
    expect(isSafeTarget(dev({ size: String(16 * 1024 ** 3) }), "")).toBe(true);
  });

  test("rejects a USB-attached SD card that IS the boot disk", () => {
    // Regression: even a USB-tran device must be filtered if it's the running
    // system's boot disk. This is the primary safety gate.
    expect(isSafeTarget(dev({ name: "sda", tran: "usb" }), "sda")).toBe(false);
  });
});
