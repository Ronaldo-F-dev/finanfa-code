import { describe, expect, it } from "vitest";
import { createSecurityBluetoothGattActiveWriteTool } from "../../src/tools/builtin/security/bluetooth-gatt-active-write.js";
import { resetCommandAvailabilityCacheForTests } from "../../src/util/command-availability.js";

const ctx = { cwd: "/tmp", sessionId: "s", signal: new AbortController().signal };
const MISSING_BIN = "/nonexistent/definitely-not-a-real-binary-xyz";

const VALID_INPUT = { deviceAddress: "AA:BB:CC:DD:EE:FF", characteristicPath: "/org/bluez/hci0/dev_AA/service0001/char0003", valueHex: "01 02" };

describe("security_bluetooth_gatt_active_write (STUB — real prerequisite checks, unimplemented run, ported from wireless-lab)", () => {
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

  it("returns a clear not-implemented error once every real precondition passes, never writing anything", async () => {
    resetCommandAvailabilityCacheForTests();
    const tool = createSecurityBluetoothGattActiveWriteTool({ platformOverride: "linux", bluetoothctlBinary: "/bin/echo" });
    const result = await tool.handler(VALID_INPUT, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/not implemented yet/i);
    expect(result.content).toMatch(/preconditions verified/i);
  });
});
