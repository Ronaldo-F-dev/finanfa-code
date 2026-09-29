import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { createSecurityWifiActiveHandshakeCaptureTool } from "../../src/tools/builtin/security/wifi-active-handshake.js";
import { resetCommandAvailabilityCacheForTests } from "../../src/util/command-availability.js";

const ctx = { cwd: "/tmp", sessionId: "s", signal: new AbortController().signal };
const FAKE_IW = fileURLToPath(new URL("../fixtures/fake-iw.mjs", import.meta.url));
const MISSING_BIN = "/nonexistent/definitely-not-a-real-binary-xyz";

describe("security_wifi_active_handshake_capture (STUB — real prerequisite checks, unimplemented run, ported from wireless-lab)", () => {
  it("has 'dangerous' risk level", () => {
    const tool = createSecurityWifiActiveHandshakeCaptureTool();
    expect(tool.riskLevel).toBe("dangerous");
  });

  it("fails cleanly on non-Linux platforms", async () => {
    const tool = createSecurityWifiActiveHandshakeCaptureTool({ platformOverride: "darwin" });
    const result = await tool.handler({ interfaceName: "wlan0", targetBssid: "aa:bb:cc:dd:ee:ff" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/targets Linux only/i);
  });

  it("really checks for the aircrack-ng suite and reports missing tools", async () => {
    resetCommandAvailabilityCacheForTests();
    const tool = createSecurityWifiActiveHandshakeCaptureTool({
      platformOverride: "linux",
      airmonNgBinary: MISSING_BIN,
      aireplayNgBinary: MISSING_BIN,
      airodumpNgBinary: MISSING_BIN,
    });
    const result = await tool.handler({ interfaceName: "wlan0", targetBssid: "aa:bb:cc:dd:ee:ff" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/airmon-ng/);
    expect(result.content).toMatch(/aireplay-ng/);
    expect(result.content).toMatch(/airodump-ng/);
  });

  it("really checks that the target interface exists and supports monitor mode, via a fake `iw`", async () => {
    resetCommandAvailabilityCacheForTests();
    const tool = createSecurityWifiActiveHandshakeCaptureTool({
      platformOverride: "linux",
      airmonNgBinary: "/bin/echo",
      aireplayNgBinary: "/bin/echo",
      airodumpNgBinary: "/bin/echo",
      iwBinary: FAKE_IW,
    });
    const missingInterface = await tool.handler({ interfaceName: "wlan9", targetBssid: "aa:bb:cc:dd:ee:ff" }, ctx);
    expect(missingInterface.isError).toBe(true);
    expect(missingInterface.content).toMatch(/not found via `iw dev`/i);
  });

  it("returns a clear not-implemented error once every real precondition passes", async () => {
    resetCommandAvailabilityCacheForTests();
    const tool = createSecurityWifiActiveHandshakeCaptureTool({
      platformOverride: "linux",
      airmonNgBinary: "/bin/echo",
      aireplayNgBinary: "/bin/echo",
      airodumpNgBinary: "/bin/echo",
      iwBinary: FAKE_IW,
    });
    const result = await tool.handler({ interfaceName: "wlan0", targetBssid: "aa:bb:cc:dd:ee:ff" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/not implemented yet/i);
    expect(result.content).toMatch(/preconditions verified/i);
  });
});
