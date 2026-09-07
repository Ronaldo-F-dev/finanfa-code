import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { createEmbeddedDevTools } from "../../src/tools/builtin/embedded-dev.js";

const ctx = { cwd: "/tmp", sessionId: "s", signal: new AbortController().signal };
const FAKE_CLI_SCRIPT = fileURLToPath(new URL("../fixtures/fake-embedded-cli.mjs", import.meta.url));

// Neither arduino-cli nor platformio is installed in this project's dev
// sandbox (both need a system package install this sandbox has no
// interactive sudo for — same situation as avrdude before it happened to
// already be present here). Tested against a real subprocess fake
// stand-in instead (same pattern as run_avrdude/run_mydevops's fixtures)
// — the wrapper logic itself (argv passthrough, cwd, exit code -> error,
// riskKey scoping) is identical regardless of which real binary is behind it.
describe("run_arduino_cli / run_platformio (real subprocess, fake embedded-CLI stand-in)", () => {
  it("has 'dangerous' risk level, scoped riskKey by subcommand", () => {
    const [arduinoCli, platformio] = createEmbeddedDevTools({ arduinoCliBinary: FAKE_CLI_SCRIPT, platformioBinary: FAKE_CLI_SCRIPT });
    expect(arduinoCli.riskLevel).toBe("dangerous");
    expect(platformio.riskLevel).toBe("dangerous");
    expect(arduinoCli.riskKey?.({ args: ["compile"] })).toBe("run_arduino_cli:compile");
    expect(platformio.riskKey?.({ args: ["run"] })).toBe("run_platformio:run");
  });

  it("run_arduino_cli passes real argv through and runs in the given cwd", async () => {
    const [arduinoCli] = createEmbeddedDevTools({ arduinoCliBinary: FAKE_CLI_SCRIPT });
    const result = await arduinoCli.handler({ args: ["compile", "--fqbn", "arduino:avr:uno", "my_sketch"] }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("ran: compile --fqbn arduino:avr:uno my_sketch");
    expect(result.content).toContain(`cwd=${ctx.cwd}`);
  });

  it("run_platformio reports a real non-zero exit as isError, with the real stderr", async () => {
    const [, platformio] = createEmbeddedDevTools({ platformioBinary: FAKE_CLI_SCRIPT });
    const result = await platformio.handler({ args: ["upload", "--upload-port", "/dev/ttyDOESNOTEXIST99"] }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("no device found");
  });

  it("defaults to the real 'arduino-cli'/'pio' binary names when no override is given", () => {
    const [arduinoCli, platformio] = createEmbeddedDevTools();
    expect(arduinoCli.describeCall?.({ args: ["board", "list"] })).toBe("arduino-cli board list");
    expect(platformio.describeCall?.({ args: ["run"] })).toBe("pio run");
  });
});
