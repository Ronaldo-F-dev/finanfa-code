import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { createSecurityScanWifiTool } from "../../src/tools/builtin/security/wifi-scan.js";
import { resetCommandAvailabilityCacheForTests } from "../../src/util/command-availability.js";

const ctx = { cwd: "/tmp", sessionId: "s", signal: new AbortController().signal };
const FAKE_AIRPORT = fileURLToPath(new URL("../fixtures/fake-airport.mjs", import.meta.url));
const FAKE_SYSTEM_PROFILER = fileURLToPath(new URL("../fixtures/fake-system-profiler-bluetooth.mjs", import.meta.url));
const FAKE_NMCLI = fileURLToPath(new URL("../fixtures/fake-nmcli.mjs", import.meta.url));
const MISSING_BIN = "/nonexistent/definitely-not-a-real-binary-xyz";

describe("security_scan_wifi (real subprocess, fake airport/nmcli/system_profiler stand-ins)", () => {
  it("has 'safe' risk level", () => {
    const tool = createSecurityScanWifiTool();
    expect(tool.riskLevel).toBe("safe");
  });

  it("macOS: parses realistic `airport -s` output into a clean structured result, flagging weak security", async () => {
    resetCommandAvailabilityCacheForTests();
    const tool = createSecurityScanWifiTool({ platformOverride: "darwin", airportBinary: FAKE_AIRPORT });
    const result = await tool.handler({}, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("HomeNetwork");
    expect(result.content).toContain("CoffeeShop");
    expect(result.content).toContain("OldRouter");
    // Open + WEP networks are real findings; the WPA2 network is a passed control.
    expect(result.content).toMatch(/no encryption \(open network\)/i);
    expect(result.content).toMatch(/WEP/);
    expect(result.content).toContain("Passed controls:");
    const networks = result.metadata?.networks as unknown[];
    expect(networks.length).toBe(3);
  });

  it("macOS: falls back to system_profiler (current network only) when airport is missing, without crashing", async () => {
    resetCommandAvailabilityCacheForTests();
    const tool = createSecurityScanWifiTool({ platformOverride: "darwin", airportBinary: MISSING_BIN, systemProfilerBinary: FAKE_SYSTEM_PROFILER });
    const result = await tool.handler({}, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("HomeNetwork");
    expect(result.content).toMatch(/airport utility not found/i);
    const networks = result.metadata?.networks as unknown[];
    expect(networks.length).toBe(1);
  });

  it("Linux: parses realistic nmcli terse output, unescaping colon-separated BSSIDs", async () => {
    resetCommandAvailabilityCacheForTests();
    const tool = createSecurityScanWifiTool({ platformOverride: "linux", nmcliBinary: FAKE_NMCLI });
    const result = await tool.handler({}, ctx);
    expect(result.isError).toBe(false);
    const networks = result.metadata?.networks as Array<{ ssid: string; bssid?: string; security: string }>;
    expect(networks.length).toBe(3);
    const home = networks.find((n) => n.ssid === "HomeNetwork")!;
    expect(home.bssid).toBe("12:34:56:78:9A:BC");
    expect(home.security).toBe("wpa2");
    const coffee = networks.find((n) => n.ssid === "CoffeeShop")!;
    expect(coffee.security).toBe("open");
    const old = networks.find((n) => n.ssid === "OldRouter")!;
    expect(old.security).toBe("wep");
  });

  it("reports 'not available' rather than crashing when no platform tool is found", async () => {
    resetCommandAvailabilityCacheForTests();
    const tool = createSecurityScanWifiTool({ platformOverride: "linux", nmcliBinary: MISSING_BIN, iwlistBinary: MISSING_BIN });
    const result = await tool.handler({}, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("No nearby Wi-Fi networks found or enumerable.");
    expect(result.content).toMatch(/nmcli unavailable/i);
  });
});
