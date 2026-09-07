import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { createFirmwareFlashTools } from "../../src/tools/builtin/firmware-flash.js";

const ctx = { cwd: "/tmp", sessionId: "s", signal: new AbortController().signal };
const FAKE_AVRDUDE_SCRIPT = fileURLToPath(new URL("../fixtures/fake-avrdude.mjs", import.meta.url));

// esptool (Espressif's real official ESP32/ESP8266 tool) is genuinely
// installable without root (a plain pip/venv install, no native
// compilation) and was actually installed for this test run — so
// run_esptool is tested against the REAL binary, not a stand-in.
// avrdude needs a system package install this sandbox has no
// interactive sudo for, so run_avrdude is tested against a real
// subprocess fake stand-in instead (same pattern as run_mydevops/
// schedule_task's fake-mydevops.mjs/fake-crontab.mjs) — its own wrapper
// logic is identical to esptool's either way.
const ESPTOOL_BIN = process.env.ESPTOOL_BIN_FOR_TESTS;

describe.skipIf(!ESPTOOL_BIN)("run_esptool (real esptool binary)", () => {
  it("has 'dangerous' risk level, scoped riskKey by subcommand", () => {
    const [esptool] = createFirmwareFlashTools({ esptoolBinary: ESPTOOL_BIN });
    expect(esptool.riskLevel).toBe("dangerous");
    expect(esptool.riskKey?.({ args: ["write-flash"] })).toBe("run_esptool:write-flash");
  });

  it("runs the real 'version' subcommand successfully with no device attached", async () => {
    const [esptool] = createFirmwareFlashTools({ esptoolBinary: ESPTOOL_BIN });
    const result = await esptool.handler({ args: ["version"] }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toMatch(/esptool v\d+\.\d+\.\d+/);
  }, 20_000);

  it("reports a real connection failure for a nonexistent serial port, not a thrown exception", async () => {
    const [esptool] = createFirmwareFlashTools({ esptoolBinary: ESPTOOL_BIN });
    const result = await esptool.handler({ args: ["--port", "/dev/ttyDOESNOTEXIST99", "chip-id"] }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content.toLowerCase()).toMatch(/could not open|no such file/);
  }, 20_000);
});

describe("run_avrdude (real subprocess, fake avrdude stand-in — see header comment for why)", () => {
  it("has 'dangerous' risk level, scoped riskKey by subcommand", () => {
    const [, avrdude] = createFirmwareFlashTools({ avrdudeBinary: FAKE_AVRDUDE_SCRIPT });
    expect(avrdude.riskLevel).toBe("dangerous");
    expect(avrdude.riskKey?.({ args: ["-c", "arduino"] })).toBe("run_avrdude:-c");
  });

  it("passes real argv through to the real subprocess", async () => {
    const [, avrdude] = createFirmwareFlashTools({ avrdudeBinary: FAKE_AVRDUDE_SCRIPT });
    const result = await avrdude.handler({ args: ["-c", "arduino", "-p", "atmega328p"] }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain('["-c","arduino","-p","atmega328p"]');
  });

  it("reports a nonexistent port failure as a tool error with the real stderr", async () => {
    const [, avrdude] = createFirmwareFlashTools({ avrdudeBinary: FAKE_AVRDUDE_SCRIPT });
    const result = await avrdude.handler({ args: ["-P", "/dev/ttyDOESNOTEXIST99", "-c", "arduino"] }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("can't open device");
  });

  it("defaults to the real 'esptool'/'avrdude' binary names when no override is given", () => {
    const [esptool, avrdude] = createFirmwareFlashTools();
    expect(esptool.describeCall?.({ args: ["version"] })).toBe("esptool version");
    expect(avrdude.describeCall?.({ args: ["-v"] })).toBe("avrdude -v");
  });
});
