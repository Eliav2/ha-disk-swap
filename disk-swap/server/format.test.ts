import { describe, expect, test } from "bun:test";
import { formatBytes } from "../shared/format.ts";

describe("formatBytes", () => {
  test("MB rounding for sub-GB values", () => {
    expect(formatBytes(0)).toBe("0 MB");
    expect(formatBytes(1024 ** 2)).toBe("1 MB");
    expect(formatBytes(500 * 1024 ** 2)).toBe("500 MB");
  });

  test("GB with one decimal", () => {
    expect(formatBytes(1024 ** 3)).toBe("1.0 GB");
    expect(formatBytes(8 * 1024 ** 3)).toBe("8.0 GB");
    expect(formatBytes(16.5 * 1024 ** 3)).toBe("16.5 GB");
  });

  test("TB with one decimal", () => {
    expect(formatBytes(1024 ** 4)).toBe("1.0 TB");
    expect(formatBytes(2.5 * 1024 ** 4)).toBe("2.5 TB");
  });

  test("boundary: just under 1 GB stays in MB", () => {
    expect(formatBytes(1024 ** 3 - 1)).toBe("1024 MB");
  });
});
