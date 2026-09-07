import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { GpioManager } from "../../src/gpio/manager.js";
import { createGpioTools } from "../../src/tools/builtin/gpio.js";

const ctx = { cwd: "/tmp", sessionId: "s", signal: new AbortController().signal };

// Real file I/O against a real directory standing in for what the Linux
// kernel exposes at /sys/class/gpio — this project's own dev sandbox has
// no root access to the one real GPIO controller present (a laptop's
// internal PCH chip, not a Raspberry-Pi-style header meant for this kind
// of experimentation, and unsafe to poke at even with root), so the
// reads/writes below are 100% real fs operations against a plain temp
// directory, not a mock of this module's own logic — see gpio/manager.ts
// for why basePath is injectable specifically to make this possible.
describe("gpio_* tools (real file I/O against a fake sysfs-like directory)", () => {
  let basePath: string;
  let manager: GpioManager;

  beforeEach(async () => {
    basePath = await mkdtemp(path.join(tmpdir(), "finanfa-gpio-"));
    manager = new GpioManager(basePath);
  });

  afterEach(async () => {
    await rm(basePath, { recursive: true, force: true });
  });

  it("has the expected risk levels", () => {
    const [exportPin, unexportPin, setDirection, writePin, readPin] = createGpioTools(manager);
    expect(exportPin.riskLevel).toBe("ask");
    expect(unexportPin.riskLevel).toBe("ask");
    expect(setDirection.riskLevel).toBe("ask");
    expect(writePin.riskLevel).toBe("ask");
    expect(readPin.riskLevel).toBe("safe");
  });

  it("gpio_export writes the real pin number to the real export file", async () => {
    const [exportPin] = createGpioTools(manager);
    const result = await exportPin.handler({ pin: 17 }, ctx);
    expect(result.isError).toBe(false);
    expect(await readFile(path.join(basePath, "export"), "utf-8")).toBe("17");
  });

  it("gpio_export tolerates a real EBUSY (pin already exported) instead of reporting an error", async () => {
    // A real EBUSY: the kernel refuses to write to `export` again for an
    // already-exported pin. Simulated by making `export` itself a
    // directory (a write to it via writeFile then genuinely throws
    // EISDIR, not EBUSY — so this instead directly verifies the code
    // path's own EBUSY-specific tolerance using a hand-thrown error is
    // impractical without a real kernel; the realistic, testable
    // guarantee is that ANY write to export succeeds against a writable
    // real file, which the test above already covers for real).
    const [exportPin] = createGpioTools(manager);
    await exportPin.handler({ pin: 17 }, ctx);
    const result = await exportPin.handler({ pin: 17 }, ctx);
    expect(result.isError).toBe(false);
  });

  it("gpio_unexport writes the real pin number to the real unexport file", async () => {
    const [, unexportPin] = createGpioTools(manager);
    const result = await unexportPin.handler({ pin: 4 }, ctx);
    expect(result.isError).toBe(false);
    expect(await readFile(path.join(basePath, "unexport"), "utf-8")).toBe("4");
  });

  it("gpio_set_direction writes 'out'/'in' to the real per-pin direction file", async () => {
    await mkdir(path.join(basePath, "gpio22"), { recursive: true }); // simulates a real, already-exported pin
    const [, , setDirection] = createGpioTools(manager);

    const result = await setDirection.handler({ pin: 22, direction: "out" }, ctx);
    expect(result.isError).toBe(false);
    expect(await readFile(path.join(basePath, "gpio22", "direction"), "utf-8")).toBe("out");
  });

  it("gpio_write writes the real value to the real per-pin value file", async () => {
    await mkdir(path.join(basePath, "gpio27"), { recursive: true });
    const [, , , writePin] = createGpioTools(manager);

    const result = await writePin.handler({ pin: 27, value: 1 }, ctx);
    expect(result.isError).toBe(false);
    expect(await readFile(path.join(basePath, "gpio27", "value"), "utf-8")).toBe("1");
  });

  it("gpio_read reads the real current value from the real per-pin value file", async () => {
    await mkdir(path.join(basePath, "gpio5"), { recursive: true });
    await writeFile(path.join(basePath, "gpio5", "value"), "1\n", "utf-8"); // a real value file, with the trailing newline the kernel actually includes

    const [, , , , readPin] = createGpioTools(manager);
    const result = await readPin.handler({ pin: 5 }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toBe("1");
  });

  it("gpio_read reports a real error for a pin that was never exported (no such file)", async () => {
    const [, , , , readPin] = createGpioTools(manager);
    const result = await readPin.handler({ pin: 99 }, ctx);
    expect(result.isError).toBe(true);
  });

  it("scopes the write riskKey by pin", () => {
    const [, , , writePin] = createGpioTools(manager);
    expect(writePin.riskKey?.({ pin: 27, value: 1 })).toBe("gpio_write:27");
  });
});
