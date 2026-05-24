import { describe, expect, test } from "bun:test";
import { machineToBoardSlug } from "./supervisor.ts";

describe("machineToBoardSlug", () => {
  test("maps common HA machine names to HAOS board slugs", () => {
    expect(machineToBoardSlug("raspberrypi4-64")).toBe("rpi4-64");
    expect(machineToBoardSlug("raspberrypi3")).toBe("rpi3");
    expect(machineToBoardSlug("generic-x86-64")).toBe("generic-x86-64");
    expect(machineToBoardSlug("odroid-n2")).toBe("odroid-n2");
    expect(machineToBoardSlug("yellow")).toBe("yellow");
  });

  test("maps qemu test machines to their generic-arch equivalents", () => {
    expect(machineToBoardSlug("qemuarm-64")).toBe("generic-aarch64");
    expect(machineToBoardSlug("qemux86-64")).toBe("generic-x86-64");
  });

  test("throws on unknown machine type", () => {
    expect(() => machineToBoardSlug("totally-fake-board")).toThrow(
      /Unsupported machine type/,
    );
  });
});
