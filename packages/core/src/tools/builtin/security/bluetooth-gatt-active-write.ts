import type { ToolDefinition } from "../../../core/types.js";
import { isCommandAvailable } from "../../../util/command-availability.js";
import { isValidGattPath, isValidMacAddress, normalizeGattWriteBytes, writeGattCharacteristic } from "./bluetooth-gatt.js";

// Active GATT characteristic write. Ported from wireless-lab's
// bluetooth/gatt/src/active-write.ts (BluetoothGattActiveWriteModule):
// writing to a characteristic changes device state and, for some services,
// can trigger real-world side effects (locks, actuators, firmware update
// paths) — an active, state-changing operation, not read-only enumeration
// (see security_scan_bluetooth's deviceAddress/readCharacteristicPaths for
// that). Gated behind this tool's "dangerous" risk tier and only ever run
// against a device the user is explicitly, documentedly authorized to test.

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
      "Security tool. Writes a value to a BLE GATT characteristic (via bluetoothctl's interactive GATT menu), " +
      "for write-based robustness/fuzzing testing or exercising a device's write-based functionality. Connects " +
      "to the device, writes the given hex bytes to the characteristic at `characteristicPath` (from a prior " +
      "security_scan_bluetooth GATT-discovery call), reads the value straight back where possible, and " +
      "disconnects. Linux-only (bluetoothctl). " +
      "IMPORTANT: this is an active, state-changing operation against real physical hardware — writing to a " +
      "characteristic can trigger real-world side effects (locks, actuators, firmware update paths), unlike " +
      "read-only enumeration (see security_scan_bluetooth). Only ever run it against a device the user owns or " +
      "has explicit, documented authorization to test, and confirm the exact value/target with them first.",
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
    describeCall: (input) => `write ${input.valueHex} to ${input.characteristicPath} on ${input.deviceAddress}`,
    async handler(input) {
      // Preconditions first (pure detection, no write): platform, tool,
      // and both targets must be present before anything touches the device.
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
      // Real format validation, not just "is it non-empty" — both values get
      // spliced directly into a line written to bluetoothctl's interactive
      // stdin (see writeGattCharacteristic/isValidMacAddress/isValidGattPath),
      // so anything outside a real MAC-address/D-Bus-path shape (a newline,
      // in particular) could inject an extra bluetoothctl command.
      if (!isValidMacAddress(input.deviceAddress)) {
        return { content: `"${input.deviceAddress}" is not a valid device address — expected a MAC address like "AA:BB:CC:DD:EE:FF".`, isError: true };
      }
      if (!isValidGattPath(input.characteristicPath)) {
        return { content: `"${input.characteristicPath}" is not a valid GATT characteristic path — expected a bluez object path like "/org/bluez/hci0/dev_.../char....." (from a prior security_scan_bluetooth GATT discovery call).`, isError: true };
      }
      // Validate the value BEFORE connecting — never open a connection to a
      // real device just to discover the hex was malformed.
      const normalized = normalizeGattWriteBytes(input.valueHex);
      if ("error" in normalized) {
        return { content: normalized.error, isError: true };
      }

      const result = await writeGattCharacteristic(bluetoothctlBin, input.deviceAddress, input.characteristicPath, normalized.bytes);
      if (!result.connected) {
        return { content: result.detail, isError: true };
      }
      const readBack = result.readBackHex !== undefined ? ` Read-back value: ${result.readBackHex}.` : " (characteristic not readable back — write-only, or read not permitted.)";
      if (!result.ok) {
        return {
          content: `Wrote ${normalized.bytes.length} byte(s) to ${input.characteristicPath} on ${input.deviceAddress}, but bluetoothctl reported it did not succeed: ${result.detail}.${readBack}`,
          isError: true,
        };
      }
      return {
        content: `Wrote ${normalized.bytes.length} byte(s) (${normalized.bytes.join(" ")}) to ${input.characteristicPath} on ${input.deviceAddress}. ${result.detail}.${readBack}`,
        isError: false,
      };
    },
  };
}
