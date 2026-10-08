import { describe, expect, it, beforeAll } from "vitest";
import { chmod } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createListUsbDevicesTool, createRunAdbCommandTool, createRunIosSshCommandTool } from "../../src/tools/builtin/usb-devices.js";
import { resetCommandAvailabilityCacheForTests } from "../../src/util/command-availability.js";

const ctx = { cwd: "/tmp", sessionId: "s", signal: new AbortController().signal };
const FAKE_ADB = fileURLToPath(new URL("../fixtures/fake-adb.mjs", import.meta.url));
const FAKE_SYSTEM_PROFILER = fileURLToPath(new URL("../fixtures/fake-system-profiler.mjs", import.meta.url));
const FAKE_IPROXY = fileURLToPath(new URL("../fixtures/fake-iproxy.mjs", import.meta.url));
const FAKE_SSH = fileURLToPath(new URL("../fixtures/fake-ssh.mjs", import.meta.url));
const MISSING_BIN = "/nonexistent/definitely-not-a-real-binary-xyz";

/**
 * An OS-assigned free port — the fixed 3920x values this suite used collided
 * with whatever else a loaded CI runner had bound (a real observed
 * EADDRINUSE in this suite's own teardown test), the same lesson as
 * spawn-server.ts's PORT=0 switch.
 */
async function freePort(): Promise<number> {
  const net = await import("node:net");
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as import("node:net").AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

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

describe("run_ios_ssh_command (real subprocess, fake iproxy + ssh stand-ins)", () => {
  beforeAll(async () => {
    await chmod(FAKE_IPROXY, 0o755);
    await chmod(FAKE_SSH, 0o755);
  });

  it("has 'dangerous' risk level, scoped riskKey by udid", () => {
    const tool = createRunIosSshCommandTool({ iproxyBinary: FAKE_IPROXY, sshBinary: FAKE_SSH });
    expect(tool.riskLevel).toBe("dangerous");
    expect(tool.riskKey?.({ udid: "abc-123", command: "whoami" })).toBe("run_ios_ssh_command:abc-123");
  });

  it("starts the iproxy tunnel, runs the SSH command against the tunneled local port, and returns real output", async () => {
    resetCommandAvailabilityCacheForTests();
    const tool = createRunIosSshCommandTool({ iproxyBinary: FAKE_IPROXY, sshBinary: FAKE_SSH });
    const port = await freePort();
    const result = await tool.handler({ udid: "00008030-000ABC123", command: "whoami", local_port: port }, ctx);
    expect(result.isError).toBe(false);
    // fake-ssh.mjs echoes its own real argv for the "whoami" command — confirms
    // the tunnel's local port and default root user actually made it into the
    // real ssh argv, not just some hardcoded/skipped value.
    expect(result.content).toContain(`"-p","${port}"`);
    expect(result.content).toContain('"root@127.0.0.1"');
  }, 15_000);

  it("respects an overridden user", async () => {
    resetCommandAvailabilityCacheForTests();
    const tool = createRunIosSshCommandTool({ iproxyBinary: FAKE_IPROXY, sshBinary: FAKE_SSH });
    const result = await tool.handler({ udid: "00008030-000ABC124", command: "whoami", local_port: await freePort(), user: "mobile" }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain('"mobile@127.0.0.1"');
  }, 15_000);

  it("gives a clear 'iproxy not found' error, not a cryptic ENOENT, when iproxy is missing", async () => {
    resetCommandAvailabilityCacheForTests();
    const tool = createRunIosSshCommandTool({ iproxyBinary: MISSING_BIN, sshBinary: FAKE_SSH });
    const result = await tool.handler({ udid: "00008030-000ABC125", command: "whoami" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("iproxy not found");
    expect(result.content).toContain("libimobiledevice");
    expect(result.content).not.toContain("ENOENT");
  });

  it("tears down the iproxy process after the command completes — the local port is free again afterwards", async () => {
    resetCommandAvailabilityCacheForTests();
    const tool = createRunIosSshCommandTool({ iproxyBinary: FAKE_IPROXY, sshBinary: FAKE_SSH });
    const port = await freePort();
    const result = await tool.handler({ udid: "00008030-000ABC126", command: "whoami", local_port: port }, ctx);
    expect(result.isError).toBe(false);

    // If the fake iproxy process were still alive, this port would still be
    // bound and a fresh listen() on it would fail with EADDRINUSE.
    const net = await import("node:net");
    await new Promise<void>((resolve, reject) => {
      const probe = net.createServer();
      probe.once("error", reject);
      probe.listen(port, "127.0.0.1", () => probe.close(() => resolve()));
    });
  }, 15_000);

  it("reports a clear error (not a hang) when the tunnel comes up but nothing SSH-like is listening on the other end", async () => {
    resetCommandAvailabilityCacheForTests();
    // No sshBinary override here — this exercises the REAL system `ssh`
    // client against fake-iproxy's "refused" mode, which accepts the local
    // TCP connection (so the tunnel itself looks up) and then immediately
    // resets it, exactly like a real iproxy forwarding to a device whose SSH
    // server isn't running. Real ssh fails the handshake fast (exit 255),
    // it doesn't hang.
    const tool = createRunIosSshCommandTool({ iproxyBinary: FAKE_IPROXY });
    const result = await tool.handler({ udid: "00008030-refused-device", command: "whoami", local_port: await freePort(), timeout_ms: 8_000 }, ctx);
    expect(result.isError).toBe(true);
  }, 20_000);
});
