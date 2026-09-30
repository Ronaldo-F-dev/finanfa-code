import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { createSecurityScanBluetoothTool } from "../../src/tools/builtin/security/bluetooth-scan.js";
import { resetCommandAvailabilityCacheForTests } from "../../src/util/command-availability.js";

const ctx = { cwd: "/tmp", sessionId: "s", signal: new AbortController().signal };
const FAKE_SYSTEM_PROFILER = fileURLToPath(new URL("../fixtures/fake-system-profiler-bluetooth.mjs", import.meta.url));
const FAKE_BLUETOOTHCTL = fileURLToPath(new URL("../fixtures/fake-bluetoothctl.mjs", import.meta.url));
const FAKE_BLUETOOTHCTL_INTERACTIVE = fileURLToPath(new URL("../fixtures/fake-bluetoothctl-interactive.mjs", import.meta.url));
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

describe("security_scan_bluetooth deviceAddress (read-only GATT discovery, ported from wireless-lab)", () => {
  it("has 'safe' risk level even with deviceAddress (read-only, no writes)", () => {
    const tool = createSecurityScanBluetoothTool();
    expect(tool.riskLevel).toBe("safe");
  });

  it("rejects GATT discovery on non-Linux platforms (no macOS bluetoothctl GATT menu equivalent)", async () => {
    resetCommandAvailabilityCacheForTests();
    const tool = createSecurityScanBluetoothTool({ platformOverride: "darwin" });
    const result = await tool.handler({ deviceAddress: "AA:BB:CC:DD:EE:FF" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/targets Linux only/i);
  });

  it("reports bluetoothctl missing rather than crashing", async () => {
    resetCommandAvailabilityCacheForTests();
    const tool = createSecurityScanBluetoothTool({ platformOverride: "linux", bluetoothctlBinary: MISSING_BIN });
    const result = await tool.handler({ deviceAddress: "AA:BB:CC:DD:EE:FF" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/bluetoothctl not found/i);
  });

  it("discovers attributes and reads a characteristic via the fake interactive bluetoothctl", async () => {
    resetCommandAvailabilityCacheForTests();
    const tool = createSecurityScanBluetoothTool({ platformOverride: "linux", bluetoothctlBinary: FAKE_BLUETOOTHCTL_INTERACTIVE });
    const path = "/org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF/service0001/char0003";
    const result = await tool.handler({ deviceAddress: "AA:BB:CC:DD:EE:FF", readCharacteristicPaths: [path] }, ctx);
    expect(result.isError).toBe(false);
    const discovery = result.metadata?.discovery as { attributes: Array<{ uuid: string }>; values: Record<string, string> };
    expect(discovery.attributes.length).toBeGreaterThan(0);
    expect(discovery.attributes.some((a) => a.uuid === "00001800-0000-1000-8000-00805f9b34fb")).toBe(true);
    expect(Buffer.from(discovery.values[path], "hex").toString("utf-8")).toBe("Wireless-Lab");
  }, 10_000);

  it("flags a known legacy vendor UART-bridge service as a finding", async () => {
    resetCommandAvailabilityCacheForTests();
    // A dedicated fixture variant isn't needed: bluetoothctl's list-attributes
    // output is plain text, so a small custom fake stands in here rather than
    // extending the shared interactive fixture's fixed script.
    const fakeWithLegacyService = fileURLToPath(new URL("../fixtures/fake-bluetoothctl-interactive-legacy.mjs", import.meta.url));
    const tool = createSecurityScanBluetoothTool({ platformOverride: "linux", bluetoothctlBinary: fakeWithLegacyService });
    const result = await tool.handler({ deviceAddress: "AA:BB:CC:DD:EE:FF" }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toMatch(/Legacy\/vendor UART-bridge service exposed/i);
  }, 10_000);

  // Real command-injection gap, same class as the one already fixed in
  // security_bluetooth_gatt_active_write — and more urgent here, since this
  // tool is riskLevel "safe" (no permission prompt at all). deviceAddress/
  // readCharacteristicPaths used to get spliced directly into bluetoothctl's
  // interactive stdin with only a non-empty check, so a newline embedded in
  // either field could inject a second, unauthorized bluetoothctl command
  // with zero user confirmation. These fail BEFORE ever spawning
  // bluetoothctl (bluetoothctlBinary set to a real, would-crash-if-reached
  // binary would make that failure loud rather than silent).
  it("rejects a deviceAddress shaped to inject a second bluetoothctl command via an embedded newline", async () => {
    resetCommandAvailabilityCacheForTests();
    const tool = createSecurityScanBluetoothTool({ platformOverride: "linux", bluetoothctlBinary: FAKE_BLUETOOTHCTL_INTERACTIVE });
    const result = await tool.handler({ deviceAddress: "AA:BB:CC:DD:EE:FF\nremove-device AA:BB:CC:DD:EE:FF" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/not a valid device address/i);
  });

  it("rejects a readCharacteristicPaths entry shaped to inject a second bluetoothctl command", async () => {
    resetCommandAvailabilityCacheForTests();
    const tool = createSecurityScanBluetoothTool({ platformOverride: "linux", bluetoothctlBinary: FAKE_BLUETOOTHCTL_INTERACTIVE });
    const result = await tool.handler(
      { deviceAddress: "AA:BB:CC:DD:EE:FF", readCharacteristicPaths: ["/org/bluez/hci0/dev_AA/char0003\ndisconnect"] },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/not a valid GATT characteristic path/i);
  });

  it("still accepts a real, well-formed device address and characteristic path (no over-broad rejection)", async () => {
    resetCommandAvailabilityCacheForTests();
    const tool = createSecurityScanBluetoothTool({ platformOverride: "linux", bluetoothctlBinary: FAKE_BLUETOOTHCTL_INTERACTIVE });
    const path = "/org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF/service0001/char0003";
    const result = await tool.handler({ deviceAddress: "AA:BB:CC:DD:EE:FF", readCharacteristicPaths: [path] }, ctx);
    expect(result.isError).toBe(false);
  }, 10_000);
});
