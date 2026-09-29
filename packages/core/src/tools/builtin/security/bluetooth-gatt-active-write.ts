import type { ToolDefinition } from "../../../core/types.js";
import { isCommandAvailable } from "../../../util/command-availability.js";

// STUB — active GATT characteristic write. Ported from wireless-lab's
// bluetooth/gatt/src/active-write.ts (BluetoothGattActiveWriteModule):
// checkPrerequisites is real and fully implemented below (verifying tool/
// platform/target preconditions is pure detection, not a write); run()
// intentionally returns a not-implemented error — writing to a
// characteristic changes device state and, for some services, can trigger
// real-world side effects (locks, actuators, firmware update paths), an
// active/state-changing operation rather than read-only enumeration, and
// needs the user's own implementation plus explicit authorization for the
// target device. Fill in the "not implemented" branch below once ready.

export interface BluetoothGattActiveWriteOptions {
  bluetoothctlBinary?: string;
  platformOverride?: NodeJS.Platform;
}

interface BluetoothGattActiveWriteInput {
  deviceAddress: string;
  characteristicPath: string;
  valueHex: string;
}

export function createSecurityBluetoothGattActiveWriteTool(options: BluetoothGattActiveWriteOptions = {}): ToolDefinition<BluetoothGattActiveWriteInput> {
  const platform = options.platformOverride ?? process.platform;
  const bluetoothctlBin = options.bluetoothctlBinary ?? "bluetoothctl";

  return {
    name: "security_bluetooth_gatt_active_write",
    description:
      "STUB — NOT YET IMPLEMENTED. Intended to write a value to a BLE GATT characteristic (via bluetoothctl's " +
      "interactive GATT menu), for write-based robustness/fuzzing testing or exercising a device's write-based " +
      "functionality. Writing to a characteristic changes device state and, for some services, can trigger " +
      "real-world side effects (locks, actuators, firmware update paths) — an active operation, not read-only " +
      "enumeration (see security_scan_bluetooth's deviceAddress/readCharacteristicPaths for that), and requires " +
      "explicit, documented authorization for the target device before ever being run. Currently only verifies " +
      "real preconditions (platform, bluetoothctl installed, device address + characteristic path given) and " +
      "then returns a clear not-implemented error — see this tool's handler in bluetooth-gatt-active-write.ts " +
      "for the TODO describing what belongs in it.",
    riskLevel: "dangerous",
    inputSchema: {
      type: "object",
      properties: {
        deviceAddress: { type: "string", description: "Target device address (from security_scan_bluetooth)" },
        characteristicPath: { type: "string", description: "Target characteristic's D-Bus object path (from a prior security_scan_bluetooth deviceAddress/GATT-discovery call)" },
        valueHex: { type: "string", description: "Value to write, as hex bytes (e.g. \"01 02 03\")" },
      },
      required: ["deviceAddress", "characteristicPath", "valueHex"],
    },
    riskKey: (input) => `security_bluetooth_gatt_active_write:${input.deviceAddress}`,
    describeCall: (input) => `[STUB, not implemented] write ${input.valueHex} to ${input.characteristicPath} on ${input.deviceAddress}`,
    async handler(input) {
      // --- real, working prerequisite checks (mirrors wireless-lab's
      // checkPrerequisites — verifying preconditions is pure detection, not
      // a write) ---
      if (platform !== "linux") {
        return { content: `GATT writes via bluetoothctl target Linux only; this host reports platform "${platform}".`, isError: true };
      }
      if (!isCommandAvailable(bluetoothctlBin)) {
        return { content: "bluetoothctl not found (install bluez).", isError: true };
      }
      if (!input.deviceAddress) {
        return { content: "A target device address is required.", isError: true };
      }
      if (!input.characteristicPath) {
        return { content: "A target characteristic path is required (from a prior security_scan_bluetooth GATT discovery call).", isError: true };
      }

      // --- not implemented past this point ---
      // TODO (fill this in yourself, once authorized against the target
      // device): the actual characteristic write belongs here. Roughly:
      //   1. Open a BluetoothctlSession (see ./bluetooth-gatt.ts, already
      //      built) and connect to the target device (`connect
      //      <deviceAddress>`), confirming "Connection successful" rather
      //      than assuming it.
      //   2. `menu gatt`, then `select-attribute <characteristicPath>`.
      //   3. `write <space-separated hex bytes>` (or `write "<value>"`
      //      depending on bluetoothctl version), and read back its response
      //      line for success/failure — bluetoothctl reports write errors
      //      (e.g. "Not permitted", "Invalid Value Length") in its own
      //      text.
      //   4. Decide whether to verify the write by immediately reading the
      //      characteristic back (only meaningful if it isn't write-only).
      //   5. Disconnect cleanly in a `finally`, whatever the outcome.
      // Handle: characteristic not writable, write rejected by the
      // peripheral, and the value being longer than the characteristic's
      // declared MTU.
      return {
        content:
          "Preconditions verified (platform, bluetoothctl, device address, characteristic path), but the " +
          "actual GATT write is not implemented yet — see the TODO comment in this tool's handler " +
          "(packages/core/src/tools/builtin/security/bluetooth-gatt-active-write.ts) for the 5 steps it needs.",
        isError: true,
      };
    },
  };
}
