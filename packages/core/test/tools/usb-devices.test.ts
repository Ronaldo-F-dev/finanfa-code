import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { createListUsbDevicesTool, createRunAdbCommandTool } from "../../src/tools/builtin/usb-devices.js";
import { resetCommandAvailabilityCacheForTests } from "../../src/util/command-availability.js";

const ctx = { cwd: "/tmp", sessionId: "s", signal: new AbortController().signal };
const FAKE_ADB = fileURLToPath(new URL("../fixtures/fake-adb.mjs", import.meta.url));
const FAKE_SYSTEM_PROFILER = fileURLToPath(new URL("../fixtures/fake-system-profiler.mjs", import.meta.url));
const MISSING_BIN = "/nonexistent/definitely-not-a-real-binary-xyz";

describe("list_usb_devices (real subprocess, fake system_profiler/adb stand-ins)", () => {
  it("has 'safe' risk level", () => {
    const tool = createListUsbDevicesTool();
    expect(tool.riskLevel).toBe("safe");
  });

  it("parses realistic system_profiler + adb output into a merged device list", async () => {
    resetCommandAvailabilityCacheForTests();
    const tool = createListUsbDevicesTool({
      platformOverride: "darwin",
      systemProfilerBinary: FAKE_SYSTEM_PROFILER,
      adbBinary: FAKE_ADB,
    });
    const result = await tool.handler({}, ctx);
    expect(result.isError).toBe(false);

    // system_profiler's iPhone entry, correctly guessed as iOS from its name.
    expect(result.content).toContain("phone (iOS): iPhone");
    // system_profiler's generic hub-nested storage device, not a phone.
    expect(result.content).toContain("other USB device: USB Storage Device");
    // adb's real device, merged in with its serial as id.
    expect(result.content).toContain("phone (Android): Pixel 7 Pro (id=R58N90ABCDE)");
    // adb's offline device is still reported, with its non-"device" status surfaced.
    expect(result.content).toContain("id=emulator-5554");
    expect(result.content).toContain("status=offline");

    const devices = result.metadata?.devices as unknown[];
    expect(devices.length).toBe(4);
  });

  it("reports adb as unavailable, rather than crashing, when it's missing from PATH", async () => {
    resetCommandAvailabilityCacheForTests();
    const tool = createListUsbDevicesTool({
      platformOverride: "darwin",
      systemProfilerBinary: FAKE_SYSTEM_PROFILER,
      adbBinary: MISSING_BIN,
    });
    const result = await tool.handler({}, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toMatch(/adb not available/i);
    expect(result.content).not.toContain("ENOENT");
  });

  it("reports generic USB enumeration as unavailable when system_profiler is missing, without crashing", async () => {
    resetCommandAvailabilityCacheForTests();
    const tool = createListUsbDevicesTool({
      platformOverride: "darwin",
      systemProfilerBinary: MISSING_BIN,
      adbBinary: MISSING_BIN,
    });
    const result = await tool.handler({}, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("No USB devices found.");
    expect(result.content).toMatch(/Generic USB enumeration skipped/);
  });
});

describe("run_adb_command (real subprocess, fake adb stand-in)", () => {
  it("has 'dangerous' risk level, scoped riskKey by subcommand", () => {
    const tool = createRunAdbCommandTool({ adbBinary: FAKE_ADB });
    expect(tool.riskLevel).toBe("dangerous");
    expect(tool.riskKey?.({ serial: "abc", args: ["shell", "ls"] })).toBe("run_adb_command:shell");
  });

  it("executes a real command against the fake adb stand-in and returns its output", async () => {
    resetCommandAvailabilityCacheForTests();
    const tool = createRunAdbCommandTool({ adbBinary: FAKE_ADB });
    const result = await tool.handler({ serial: "R58N90ABCDE", args: ["shell", "echo", "hi"] }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("real args received for R58N90ABCDE");
    expect(result.content).toContain('["shell","echo","hi"]');
  });

  it("reports a real device-side failure as a tool error with the real stderr", async () => {
    resetCommandAvailabilityCacheForTests();
    const tool = createRunAdbCommandTool({ adbBinary: FAKE_ADB });
    const result = await tool.handler({ serial: "R58N90ABCDE", args: ["shell", "fail"] }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("something went wrong on device");
  });

  it("gives a clear 'adb not found' error, not a cryptic ENOENT, when adb is missing", async () => {
    resetCommandAvailabilityCacheForTests();
    const tool = createRunAdbCommandTool({ adbBinary: MISSING_BIN });
    const result = await tool.handler({ serial: "abc", args: ["shell", "ls"] }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("adb not found");
    expect(result.content).toContain("Android Platform Tools");
    expect(result.content).not.toContain("ENOENT");
  });
});
