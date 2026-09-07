import type { ToolDefinition } from "../../core/types.js";
import { SerialManager } from "../../serial/manager.js";

const DEFAULT_READ_TIMEOUT_MS = 2_000;
const DEFAULT_BAUD_RATE = 115200;

/**
 * Real serial/UART tools — talk to a microcontroller, sensor, or any
 * device over a physical or virtual serial port (list ports, open one at
 * a given baud rate, write to it, read whatever it sends back, close it).
 * Keeps at most one port open across calls, the same shared-resource
 * pattern browser.ts's tools use for the shared browser page.
 */
export function createSerialTools(manager: SerialManager): ToolDefinition[] {
  const listPorts: ToolDefinition<Record<string, never>> = {
    name: "serial_list_ports",
    description: "List available serial ports on this machine (USB-connected microcontrollers, adapters, etc.), with vendor/product IDs where the OS reports them.",
    riskLevel: "safe",
    inputSchema: { type: "object", properties: {} },
    describeCall: () => "list serial ports",
    async handler() {
      try {
        const ports = await SerialManager.listPorts();
        if (ports.length === 0) return { content: "No serial ports found.", isError: false };
        const lines = ports.map((p) => `${p.path}${p.manufacturer ? ` — ${p.manufacturer}` : ""}${p.vendorId ? ` (vid=${p.vendorId}${p.productId ? ` pid=${p.productId}` : ""})` : ""}${p.serialNumber ? ` serial=${p.serialNumber}` : ""}`);
        return { content: lines.join("\n"), isError: false };
      } catch (err) {
        return { content: `Failed to list serial ports: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    },
  };

  const openPort: ToolDefinition<{ path: string; baudRate?: number }> = {
    name: "serial_open",
    description:
      "Open a serial port (see serial_list_ports for available paths) at a given baud rate (default 115200, " +
      "the common default for USB-serial/microcontroller consoles). Closes any previously open port first. " +
      "Required before serial_write/serial_read.",
    riskLevel: "ask",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Serial port path, e.g. /dev/ttyUSB0 or COM3" },
        baudRate: { type: "number", description: "Baud rate (default 115200)" },
      },
      required: ["path"],
    },
    riskKey: (input) => `serial_open:${input.path}`,
    describeCall: (input) => `open serial port ${input.path} at ${input.baudRate ?? DEFAULT_BAUD_RATE} baud`,
    async handler(input) {
      try {
        await manager.open(input.path, input.baudRate ?? DEFAULT_BAUD_RATE);
        return { content: `Opened ${input.path} at ${input.baudRate ?? DEFAULT_BAUD_RATE} baud.`, isError: false };
      } catch (err) {
        return { content: `Failed to open ${input.path}: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    },
  };

  const writePort: ToolDefinition<{ data: string; appendNewline?: boolean }> = {
    name: "serial_write",
    description:
      "Write data to the currently open serial port (see serial_open). Set appendNewline (default true) to " +
      "false for protocols/devices that don't expect a trailing newline after each write. " +
      "IMPORTANT: this sends real data to real, possibly physical hardware — confirm with the user before " +
      "sending anything that could trigger a real action (e.g. a relay, motor, or actuator command).",
    riskLevel: "ask",
    inputSchema: {
      type: "object",
      properties: {
        data: { type: "string", description: "Data to write" },
        appendNewline: { type: "boolean", description: "Append a trailing newline (default true)" },
      },
      required: ["data"],
    },
    describeCall: (input) => `write to serial port: ${JSON.stringify(input.data)}`,
    async handler(input) {
      try {
        await manager.write(input.appendNewline === false ? input.data : `${input.data}\n`);
        return { content: `Wrote ${input.data.length} byte(s).`, isError: false };
      } catch (err) {
        return { content: `Failed to write: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    },
  };

  const readPort: ToolDefinition<{ timeout_ms?: number }> = {
    name: "serial_read",
    description: "Read whatever data has arrived on the currently open serial port since the last read (or since it was opened), waiting up to timeout_ms (default 2000) if nothing has arrived yet.",
    riskLevel: "safe",
    inputSchema: { type: "object", properties: { timeout_ms: { type: "number", description: "How long to wait for data if none has arrived yet (default 2000ms)" } } },
    describeCall: () => "read from serial port",
    async handler(input) {
      try {
        const data = await manager.readAvailable(input.timeout_ms ?? DEFAULT_READ_TIMEOUT_MS);
        return { content: data.length > 0 ? data : "(no data received)", isError: false };
      } catch (err) {
        return { content: `Failed to read: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    },
  };

  const closePort: ToolDefinition<Record<string, never>> = {
    name: "serial_close",
    description: "Close the currently open serial port, if any.",
    riskLevel: "safe",
    inputSchema: { type: "object", properties: {} },
    describeCall: () => "close serial port",
    async handler() {
      await manager.close();
      return { content: "Closed.", isError: false };
    },
  };

  return [listPorts, openPort, writePort, readPort, closePort];
}
