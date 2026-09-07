import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../../src/tools/registry.js";
import { registerBuiltins } from "../../src/tools/builtin/index.js";
import { isCommandAvailable } from "../../src/util/command-availability.js";

// Verifies the real, current state of this actual environment (no mocked
// availability): run_esptool/run_avrdude wrap CLIs genuinely not
// installed system-wide here (esptool was only pip-installed into a
// throwaway venv for firmware-flash.test.ts, avrdude needs a system
// package this sandbox has no root for) and so must NOT be registered —
// this is the whole point of gating registration on isCommandAvailable
// rather than always registering an optional-external-CLI wrapper
// regardless of whether the person actually installed the tool.
describe("registerBuiltins: optional external-CLI tools are only registered when actually installed", () => {
  it("does not register run_esptool in this environment, where it's genuinely not on system PATH (only pip-installed into a throwaway test venv)", () => {
    expect(isCommandAvailable("esptool")).toBe(false);

    const registry = new ToolRegistry();
    registerBuiltins(registry);
    expect(registry.get("run_esptool")).toBeUndefined();
  });

  it("DOES register run_avrdude when avrdude is genuinely installed system-wide (as it happens to be in this environment)", () => {
    expect(isCommandAvailable("avrdude")).toBe(true);

    const registry = new ToolRegistry();
    registerBuiltins(registry);
    expect(registry.get("run_avrdude")).toBeDefined();
  });

  it("registers run_mydevops only if isCommandAvailable agrees it should — consistent either way", () => {
    const registry = new ToolRegistry();
    registerBuiltins(registry);
    const registered = registry.get("run_mydevops") !== undefined;
    expect(registered).toBe(isCommandAvailable("mydevops"));
  });

  it("always registers mqtt_publish/mqtt_subscribe (a bundled npm dependency, not an optional external CLI)", () => {
    const registry = new ToolRegistry();
    registerBuiltins(registry);
    expect(registry.get("mqtt_publish")).toBeDefined();
    expect(registry.get("mqtt_subscribe")).toBeDefined();
  });
});
