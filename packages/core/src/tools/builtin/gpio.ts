import type { ToolDefinition } from "../../core/types.js";
import { GpioManager } from "../../gpio/manager.js";

// GPIO control via Linux sysfs (e.g. a Raspberry Pi's header pins) — the
// last IoT capability in this pass, closing the "read a sensor / drive an
// actuator directly" gap the serial_*/mqtt_*/coap_request tools don't
// cover on their own. Usually needs root (or membership in the `gpio`
// group with the right udev rules) to write to /sys/class/gpio — the
// tool descriptions below say so rather than silently failing with a
// confusing permission error.
export function createGpioTools(manager: GpioManager): ToolDefinition[] {
  const exportPin: ToolDefinition<{ pin: number }> = {
    name: "gpio_export",
    description:
      "Export a GPIO pin (by its Linux GPIO number, not necessarily the board's physical pin numbering — " +
      "check the board's pinout docs) via sysfs, making it controllable. Usually requires root or gpio-group " +
      "membership. Required before gpio_set_direction/gpio_write/gpio_read.",
    riskLevel: "ask",
    inputSchema: { type: "object", properties: { pin: { type: "number", description: "GPIO pin number" } }, required: ["pin"] },
    riskKey: (input) => `gpio_export:${input.pin}`,
    describeCall: (input) => `export GPIO pin ${input.pin}`,
    async handler(input) {
      try {
        await manager.exportPin(input.pin);
        return { content: `Exported GPIO pin ${input.pin}.`, isError: false };
      } catch (err) {
        return { content: `Failed to export GPIO pin ${input.pin}: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    },
  };

  const unexportPin: ToolDefinition<{ pin: number }> = {
    name: "gpio_unexport",
    description: "Unexport a GPIO pin previously exported via gpio_export, releasing it.",
    riskLevel: "ask",
    inputSchema: { type: "object", properties: { pin: { type: "number", description: "GPIO pin number" } }, required: ["pin"] },
    riskKey: (input) => `gpio_unexport:${input.pin}`,
    describeCall: (input) => `unexport GPIO pin ${input.pin}`,
    async handler(input) {
      try {
        await manager.unexportPin(input.pin);
        return { content: `Unexported GPIO pin ${input.pin}.`, isError: false };
      } catch (err) {
        return { content: `Failed to unexport GPIO pin ${input.pin}: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    },
  };

  const setDirection: ToolDefinition<{ pin: number; direction: "in" | "out" }> = {
    name: "gpio_set_direction",
    description: "Set an exported GPIO pin's direction: 'out' to drive it (gpio_write), 'in' to read it (gpio_read).",
    riskLevel: "ask",
    inputSchema: {
      type: "object",
      properties: { pin: { type: "number", description: "GPIO pin number" }, direction: { type: "string", enum: ["in", "out"] } },
      required: ["pin", "direction"],
    },
    riskKey: (input) => `gpio_set_direction:${input.pin}`,
    describeCall: (input) => `set GPIO pin ${input.pin} direction to ${input.direction}`,
    async handler(input) {
      try {
        await manager.setDirection(input.pin, input.direction);
        return { content: `Set GPIO pin ${input.pin} direction to ${input.direction}.`, isError: false };
      } catch (err) {
        return { content: `Failed to set direction for GPIO pin ${input.pin}: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    },
  };

  const writePin: ToolDefinition<{ pin: number; value: 0 | 1 }> = {
    name: "gpio_write",
    description:
      "Drive an exported, output-direction GPIO pin high (1) or low (0). " +
      "IMPORTANT: this can trigger a real physical action (a relay, motor, LED, etc.) — confirm with the user " +
      "before writing to a pin unless they've explicitly asked for this exact change.",
    riskLevel: "ask",
    inputSchema: {
      type: "object",
      properties: { pin: { type: "number", description: "GPIO pin number" }, value: { type: "number", enum: [0, 1] } },
      required: ["pin", "value"],
    },
    riskKey: (input) => `gpio_write:${input.pin}`,
    describeCall: (input) => `set GPIO pin ${input.pin} to ${input.value}`,
    async handler(input) {
      try {
        await manager.write(input.pin, input.value);
        return { content: `Set GPIO pin ${input.pin} to ${input.value}.`, isError: false };
      } catch (err) {
        return { content: `Failed to write GPIO pin ${input.pin}: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    },
  };

  const readPin: ToolDefinition<{ pin: number }> = {
    name: "gpio_read",
    description: "Read the current value (0 or 1) of an exported, input-direction GPIO pin.",
    riskLevel: "safe",
    inputSchema: { type: "object", properties: { pin: { type: "number", description: "GPIO pin number" } }, required: ["pin"] },
    describeCall: (input) => `read GPIO pin ${input.pin}`,
    async handler(input) {
      try {
        const value = await manager.read(input.pin);
        return { content: String(value), isError: false };
      } catch (err) {
        return { content: `Failed to read GPIO pin ${input.pin}: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    },
  };

  return [exportPin, unexportPin, setDirection, writePin, readPin];
}
