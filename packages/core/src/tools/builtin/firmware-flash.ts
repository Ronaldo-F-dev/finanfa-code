import type { ToolDefinition } from "../../core/types.js";
import { createGenericCliTool } from "./generic-cli-wrapper.js";

// Firmware flashing for microcontrollers, via the real official tools —
// hand-rolling a serial bootloader protocol (ESP32's, AVR's) would be a
// far larger and riskier undertaking than this project's other hand-
// rolled wire protocols (WHOIS, MySQL/Postgres auth handshakes), which
// were chosen specifically because they're small, well-documented, and
// only need a reachability/auth check, not full read/write flashing
// support. Wraps the real, standard tools instead — same "wrap, don't
// reimplement" call as run_mydevops for the user's own separate CLI:
// - esptool (Espressif's official tool) for ESP32/ESP8266.
// - avrdude for AVR/Arduino.
// Both binary names are injectable so tests can point them at a real
// (esptool is genuinely installable, see the test file) or fake stand-in
// instead of requiring the real tool to be present in every environment
// this runs in.
const DEFAULT_TIMEOUT_MS = 120_000; // flashing a real chip can take a while, especially at a low baud rate

export interface FirmwareFlashToolOptions {
  esptoolBinary?: string;
  avrdudeBinary?: string;
}

export function createFirmwareFlashTools(options: FirmwareFlashToolOptions = {}): ToolDefinition[] {
  const esptool = createGenericCliTool(
    "run_esptool",
    "esptool",
    "Run esptool (Espressif's official ESP32/ESP8266 serial utility) — flash firmware (write-flash), read " +
      "chip info (chip-id, flash-id, read-mac), inspect a firmware image (image-info, doesn't need a real " +
      "device), merge binaries (merge-bin), erase flash, and more. Pass the subcommand as args[0] (e.g. " +
      "['write-flash', '0x1000', 'firmware.bin'], ['chip-id'], ['image-info', 'firmware.bin']) plus --port/" +
      "--baud/--chip as needed. " +
      "IMPORTANT: write-flash/erase-flash/write-flash-status modify real hardware and can be destructive " +
      "(overwriting existing firmware) — confirm with the user before running one of those against a real " +
      "device.",
    { binaryOverride: options.esptoolBinary, defaultTimeoutMs: DEFAULT_TIMEOUT_MS },
  );

  const avrdude = createGenericCliTool(
    "run_avrdude",
    "avrdude",
    "Run avrdude (the standard AVR/Arduino programmer) — flash firmware (.hex) to an AVR microcontroller, " +
      "read/write fuse bits, verify flash contents. Pass args as a plain array (e.g. ['-c', 'arduino', '-p', " +
      "'atmega328p', '-P', '/dev/ttyUSB0', '-b', '115200', '-U', 'flash:w:firmware.hex:i']). " +
      "IMPORTANT: writing flash/fuses modifies real hardware and can be destructive (a wrong fuse setting can " +
      "brick the chip until it's reprogrammed via a hardware programmer) — confirm with the user before " +
      "writing anything to a real device.",
    { binaryOverride: options.avrdudeBinary, defaultTimeoutMs: DEFAULT_TIMEOUT_MS },
  );

  return [esptool, avrdude];
}
