import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { createSecurityBluetoothGattActiveWriteTool } from "../../src/tools/builtin/security/bluetooth-gatt-active-write.js";
import { resetCommandAvailabilityCacheForTests } from "../../src/util/command-availability.js";

const ctx = { cwd: "/tmp", sessionId: "s", signal: new AbortController().signal };
const MISSING_BIN = "/nonexistent/definitely-not-a-real-binary-xyz";
// Real interactive fake: exercises connect → menu gatt → select-attribute →
// write → read → disconnect, driven over stdin exactly like real bluetoothctl.
const FAKE_BLUETOOTHCTL = fileURLToPath(new URL("../fixtures/fake-bluetoothctl-gatt-write.mjs", import.meta.url));

const VALID_INPUT = { deviceAddress: "AA:BB:CC:DD:EE:FF", characteristicPath: "/org/bluez/hci0/dev_AA/service0001/char0003", valueHex: "01 02" };

describe("security_bluetooth_gatt_active_write (real bluetoothctl interactive flow, faked binary)", () => {
  it("has 'dangerous' risk level", () => {
    const tool = createSecurityBluetoothGattActiveWriteTool();
    expect(tool.riskLevel).toBe("dangerous");
  });

  it("fails cleanly on non-Linux platforms", async () => {
    const tool = createSecurityBluetoothGattActiveWriteTool({ platformOverride: "darwin" });
    const result = await tool.handler(VALID_INPUT, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/target Linux only/i);
  });

  it("really checks bluetoothctl is available", async () => {
    resetCommandAvailabilityCacheForTests();
    const tool = createSecurityBluetoothGattActiveWriteTool({ platformOverride: "linux", bluetoothctlBinary: MISSING_BIN });
    const result = await tool.handler(VALID_INPUT, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/bluetoothctl not found/i);
  });

  it("requires deviceAddress and characteristicPath", async () => {
    resetCommandAvailabilityCacheForTests();
    const tool = createSecurityBluetoothGattActiveWriteTool({ platformOverride: "linux", bluetoothctlBinary: "/bin/echo" });
    const missingAddress = await tool.handler({ ...VALID_INPUT, deviceAddress: "" }, ctx);
    expect(missingAddress.isError).toBe(true);
    expect(missingAddress.content).toMatch(/target device address is required/i);

    const missingPath = await tool.handler({ ...VALID_INPUT, characteristicPath: "" }, ctx);
    expect(missingPath.isError).toBe(true);
    expect(missingPath.content).toMatch(/characteristic path is required/i);
  });

  it("rejects a deviceAddress that isn't a real MAC address BEFORE connecting to anything — including a newline-injection attempt", async () => {
    resetCommandAvailabilityCacheForTests();
    // /bin/echo stands in for bluetoothctl — if the handler ever reached the
    // connect step with this, a real bluetoothctl would read the embedded
    // newline as a second, separate command on its own stdin REPL.
    const tool = createSecurityBluetoothGattActiveWriteTool({ platformOverride: "linux", bluetoothctlBinary: "/bin/echo" });
    const injected = await tool.handler({ ...VALID_INPUT, deviceAddress: "AA:BB:CC:DD:EE:FF\nremove-device XX:XX:XX:XX:XX:XX" }, ctx);
    expect(injected.isError).toBe(true);
    expect(injected.content).toMatch(/not a valid device address/i);

    const malformed = await tool.handler({ ...VALID_INPUT, deviceAddress: "not-a-mac" }, ctx);
    expect(malformed.isError).toBe(true);
    expect(malformed.content).toMatch(/not a valid device address/i);
  });

  it("rejects a characteristicPath that isn't a real bluez object path BEFORE connecting to anything — including a newline-injection attempt", async () => {
    resetCommandAvailabilityCacheForTests();
    const tool = createSecurityBluetoothGattActiveWriteTool({ platformOverride: "linux", bluetoothctlBinary: "/bin/echo" });
    const injected = await tool.handler({ ...VALID_INPUT, characteristicPath: "/org/bluez/hci0/dev_AA/service0001/char0003\ndisconnect" }, ctx);
    expect(injected.isError).toBe(true);
    expect(injected.content).toMatch(/not a valid gatt characteristic path/i);

    const malformed = await tool.handler({ ...VALID_INPUT, characteristicPath: "../../etc/passwd" }, ctx);
    expect(malformed.isError).toBe(true);
    expect(malformed.content).toMatch(/not a valid gatt characteristic path/i);
  });

  it("rejects a malformed hex value BEFORE connecting to anything", async () => {
    resetCommandAvailabilityCacheForTests();
    // /bin/echo as the "bluetoothctl" — if the handler ever reached the
    // connect step with bad hex, the flow would hang/misbehave rather than
    // returning this clean validation error instantly.
    const tool = createSecurityBluetoothGattActiveWriteTool({ platformOverride: "linux", bluetoothctlBinary: "/bin/echo" });
    const result = await tool.handler({ ...VALID_INPUT, valueHex: "nothex" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/not valid hex/i);
  });

  it("writes the value over a real interactive session and reads it straight back", async () => {
    resetCommandAvailabilityCacheForTests();
    const tool = createSecurityBluetoothGattActiveWriteTool({ platformOverride: "linux", bluetoothctlBinary: FAKE_BLUETOOTHCTL });
    const result = await tool.handler({ ...VALID_INPUT, valueHex: "01 02" }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toMatch(/wrote 2 byte\(s\)/i);
    expect(result.content).toMatch(/read-back value: 0102/i);
  });

  it("reports a real connect failure instead of claiming a write happened", async () => {
    resetCommandAvailabilityCacheForTests();
    const tool = createSecurityBluetoothGattActiveWriteTool({ platformOverride: "linux", bluetoothctlBinary: FAKE_BLUETOOTHCTL });
    const result = await tool.handler({ ...VALID_INPUT, deviceAddress: "DE:AD:BE:EF:00:00" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/could not connect/i);
    expect(result.content).not.toMatch(/wrote \d+ byte/i);
  });

  it("surfaces the peripheral's own rejection of a write to a non-writable characteristic", async () => {
    resetCommandAvailabilityCacheForTests();
    const tool = createSecurityBluetoothGattActiveWriteTool({ platformOverride: "linux", bluetoothctlBinary: FAKE_BLUETOOTHCTL });
    const result = await tool.handler({ ...VALID_INPUT, characteristicPath: "/org/bluez/hci0/dev_AA/readonly/char0009" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/did not succeed/i);
    expect(result.content).toMatch(/NotPermitted/i);
  });
});
