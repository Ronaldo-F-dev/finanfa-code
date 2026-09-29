import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { createSecurityScanBluetoothTool } from "../../src/tools/builtin/security/bluetooth-scan.js";
import { resetCommandAvailabilityCacheForTests } from "../../src/util/command-availability.js";

const ctx = { cwd: "/tmp", sessionId: "s", signal: new AbortController().signal };
const FAKE_SYSTEM_PROFILER = fileURLToPath(new URL("../fixtures/fake-system-profiler-bluetooth.mjs", import.meta.url));
const FAKE_BLUETOOTHCTL = fileURLToPath(new URL("../fixtures/fake-bluetoothctl.mjs", import.meta.url));
const MISSING_BIN = "/nonexistent/definitely-not-a-real-binary-xyz";

describe("security_scan_bluetooth (real subprocess, fake system_profiler/bluetoothctl stand-ins)", () => {
  it("has 'safe' risk level", () => {
    const tool = createSecurityScanBluetoothTool();
    expect(tool.riskLevel).toBe("safe");
  });

  it("macOS: parses realistic system_profiler SPBluetoothDataType output into a clean structured result", async () => {
    resetCommandAvailabilityCacheForTests();
    const tool = createSecurityScanBluetoothTool({ platformOverride: "darwin", systemProfilerBinary: FAKE_SYSTEM_PROFILER, blueutilBinary: MISSING_BIN });
    const result = await tool.handler({}, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("AirPods Pro");
    expect(result.content).toContain("Old Keyboard");
    expect(result.content).toMatch(/blueutil not installed/i);
    const devices = result.metadata?.devices as unknown[];
    expect(devices.length).toBe(2);
  });

  it("Linux: runs a short scan window then parses `bluetoothctl devices` output", async () => {
    resetCommandAvailabilityCacheForTests();
    const tool = createSecurityScanBluetoothTool({ platformOverride: "linux", bluetoothctlBinary: FAKE_BLUETOOTHCTL, scanWindowMs: 50 });
    const result = await tool.handler({}, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("AirPods Pro");
    expect(result.content).toContain("11:22:33:44:55:66");
    const devices = result.metadata?.devices as unknown[];
    expect(devices.length).toBe(2);
  }, 10_000);

  it("reports 'not available' rather than crashing when bluetoothctl is missing", async () => {
    resetCommandAvailabilityCacheForTests();
    const tool = createSecurityScanBluetoothTool({ platformOverride: "linux", bluetoothctlBinary: MISSING_BIN });
    const result = await tool.handler({}, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("No Bluetooth devices found or enumerable.");
    expect(result.content).toMatch(/Bluetooth enumeration skipped/i);
  });
});
