import type { ToolDefinition } from "../../core/types.js";
import { createGenericCliTool } from "./generic-cli-wrapper.js";

// Embedded-development toolchains — closing the write/compile/upload
// loop the serial_*/firmware-flash tools started (they read/write raw
// bytes and flash prebuilt binaries; these compile and upload actual
// sketches/projects). Wraps the real, standard tools (same "wrap, don't
// reimplement" call as the rest of this project's CLI-wrapper tools):
// - arduino-cli (Arduino's official CLI) — compile/upload .ino sketches.
// - platformio (pio) — a broader embedded build system supporting many
//   more boards/frameworks than arduino-cli alone.
const DEFAULT_TIMEOUT_MS = 180_000; // a first-time board-package/toolchain download plus compile can be slow

export interface EmbeddedDevToolOptions {
  arduinoCliBinary?: string;
  platformioBinary?: string;
}

export function createEmbeddedDevTools(options: EmbeddedDevToolOptions = {}): ToolDefinition[] {
  const arduinoCli = createGenericCliTool(
    "run_arduino_cli",
    "arduino-cli",
    "Run arduino-cli (Arduino's official CLI) — compile (compile) and upload (upload) sketches, manage board " +
      "packages/libraries (core install, lib install), list connected boards (board list). Pass the " +
      "subcommand as args[0] (e.g. ['compile', '--fqbn', 'arduino:avr:uno', 'my_sketch'], ['upload', '--fqbn', " +
      "'arduino:avr:uno', '--port', '/dev/ttyUSB0', 'my_sketch'], ['board', 'list']). " +
      "IMPORTANT: upload writes real firmware to a real connected board — confirm with the user before " +
      "uploading to a real device unless they've explicitly asked for it.",
    { binaryOverride: options.arduinoCliBinary, defaultTimeoutMs: DEFAULT_TIMEOUT_MS },
  );

  const platformio = createGenericCliTool(
    "run_platformio",
    "pio",
    "Run PlatformIO (pio) — a broader embedded build system than arduino-cli, supporting many more boards/" +
      "frameworks (ESP-IDF, Zephyr, STM32Cube, Arduino framework on non-AVR boards, ...). Pass the subcommand " +
      "as args[0] (e.g. ['run'] to build, ['run', '--target', 'upload'] to build and flash, ['device', " +
      "'list'] to list connected boards, ['test'] to run unit tests on-device or in a simulator). " +
      "IMPORTANT: uploading writes real firmware to a real connected board — confirm with the user before " +
      "uploading to a real device unless they've explicitly asked for it.",
    { binaryOverride: options.platformioBinary, defaultTimeoutMs: DEFAULT_TIMEOUT_MS },
  );

  return [arduinoCli, platformio];
}
