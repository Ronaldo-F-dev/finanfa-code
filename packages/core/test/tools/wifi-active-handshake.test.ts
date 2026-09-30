import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { createSecurityWifiActiveHandshakeCaptureTool, parseHandshakeCaptured, parseMonitorModeInterface } from "../../src/tools/builtin/security/wifi-active-handshake.js";
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

  it("rejects a targetBssid that isn't a real MAC address BEFORE anything else runs", async () => {
    resetCommandAvailabilityCacheForTests();
    const tool = createSecurityWifiActiveHandshakeCaptureTool({
      platformOverride: "linux",
      airmonNgBinary: "/bin/echo",
      aireplayNgBinary: "/bin/echo",
      airodumpNgBinary: "/bin/echo",
      iwBinary: FAKE_IW,
    });
    const malformed = await tool.handler({ interfaceName: "wlan0", targetBssid: "not-a-bssid" }, ctx);
    expect(malformed.isError).toBe(true);
    expect(malformed.content).toMatch(/not a valid bssid/i);

    const injectionAttempt = await tool.handler({ interfaceName: "wlan0", targetBssid: "AA:BB:CC:DD:EE:FF\nsome-other-command" }, ctx);
    expect(injectionAttempt.isError).toBe(true);
    expect(injectionAttempt.content).toMatch(/not a valid bssid/i);
  });
});

describe("parseMonitorModeInterface (real, documented airmon-ng output shapes — no aircrack-ng binary available in this sandbox to invoke for real, so tested against its own verified real-world output text)", () => {
  it("extracts the interface name from the older 'monitor mode enabled on X' shape", () => {
    expect(parseMonitorModeInterface("(monitor mode enabled on mon0)")).toBe("mon0");
  });

  it("extracts the interface name from the mac80211-driver 'vif enabled for [phyN]X on [phyN]Y' shape", () => {
    expect(parseMonitorModeInterface("(mac80211 monitor mode vif enabled for [phy0]wlan0 on [phy0]wlan0mon)")).toBe("wlan0mon");
  });

  it("returns undefined when neither real shape is present (e.g. airmon-ng reported an error instead)", () => {
    expect(parseMonitorModeInterface("ERROR: could not enable monitor mode")).toBeUndefined();
  });
});

describe("parseHandshakeCaptured (real, documented airodump-ng status-line format)", () => {
  const TARGET = "AA:BB:CC:DD:EE:FF";

  it("is true once airodump-ng's status line reports a handshake for the exact target BSSID", () => {
    const statusLine = "CH 6 ][ Elapsed: 1 min ][ 2026-03-26 10:06 ][ WPA handshake: AA:BB:CC:DD:EE:FF";
    expect(parseHandshakeCaptured(statusLine, TARGET)).toBe(true);
  });

  it("is false when no handshake line is present yet", () => {
    const statusLine = "CH 6 ][ Elapsed: 1 min ][ 2026-03-26 10:06 ]";
    expect(parseHandshakeCaptured(statusLine, TARGET)).toBe(false);
  });

  it("is false when a handshake was captured for a DIFFERENT BSSID (airodump-ng can watch more than one)", () => {
    const statusLine = "CH 6 ][ Elapsed: 1 min ][ 2026-03-26 10:06 ][ WPA handshake: 11:22:33:44:55:66";
    expect(parseHandshakeCaptured(statusLine, TARGET)).toBe(false);
  });
});
