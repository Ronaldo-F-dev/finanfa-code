import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// Real Linux sysfs GPIO (the ABI documented at
// https://www.kernel.org/doc/Documentation/gpio/sysfs.txt): write a pin
// number to .../export to make .../gpioN/{direction,value} appear, then
// read/write those files directly. Implemented directly against the raw
// sysfs files (not via the `onoff` npm package, which hardcodes
// /sys/class/gpio) specifically so `basePath` is injectable — this
// project's own dev sandbox has no root access to the one real GPIO
// controller present (a laptop's internal PCH chip, not a Raspberry-Pi-
// style header meant for this kind of experimentation, and unsafe to
// poke at even with root), so tests point this at a plain temp directory
// standing in for what a real kernel would expose, rather than mocking
// this module's own file I/O — the reads/writes themselves are 100% real.
export class GpioManager {
  constructor(private readonly basePath: string = "/sys/class/gpio") {}

  private pinDir(pin: number): string {
    return path.join(this.basePath, `gpio${pin}`);
  }

  async exportPin(pin: number): Promise<void> {
    try {
      await writeFile(path.join(this.basePath, "export"), String(pin), "utf-8");
    } catch (err) {
      // EBUSY means the pin is already exported — not a real failure from the caller's perspective.
      if ((err as NodeJS.ErrnoException)?.code !== "EBUSY") throw err;
    }
  }

  async unexportPin(pin: number): Promise<void> {
    await writeFile(path.join(this.basePath, "unexport"), String(pin), "utf-8");
  }

  async setDirection(pin: number, direction: "in" | "out"): Promise<void> {
    await writeFile(path.join(this.pinDir(pin), "direction"), direction, "utf-8");
  }

  async write(pin: number, value: 0 | 1): Promise<void> {
    await writeFile(path.join(this.pinDir(pin), "value"), String(value), "utf-8");
  }

  async read(pin: number): Promise<0 | 1> {
    const raw = (await readFile(path.join(this.pinDir(pin), "value"), "utf-8")).trim();
    return raw === "1" ? 1 : 0;
  }
}
