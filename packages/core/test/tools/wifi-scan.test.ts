import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
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

describe("security_scan_wifi captureFilePath (offline pcap analysis, ported from wireless-lab)", () => {
  async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wifi-capture-test-"));
    try {
      return await fn(dir);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

  /** Builds a minimal classic-pcap file containing one 802.11 beacon frame
   * (no radiotap header, LINKTYPE_IEEE802_11) with a given SSID/BSSID/
   * channel/encryption posture. */
  function buildPcapWithBeacon(opts: { ssid: string; bssid: string; channel: number; privacy: boolean; rsn: boolean }): Buffer {
    const bssidBytes = Buffer.from(opts.bssid.split(":").map((h) => parseInt(h, 16)));
    const ssidBytes = Buffer.from(opts.ssid, "utf-8");
    const channelIe = Buffer.from([3, 1, opts.channel]);
    const ssidIe = Buffer.concat([Buffer.from([0, ssidBytes.length]), ssidBytes]);
    const rsnIe = opts.rsn ? Buffer.from([48, 2, 0x01, 0x00]) : Buffer.alloc(0);

    const frameControl = Buffer.alloc(2);
    // type=0 (management), subtype=8 (beacon); privacy bit is bit 6 of the
    // second (flags) octet of the frame-control field.
    frameControl.writeUInt16LE((0b1000 << 4) | (opts.privacy ? 0x4000 : 0), 0);

    const header = Buffer.alloc(24);
    frameControl.copy(header, 0);
    bssidBytes.copy(header, 4); // Address1 (unused by the parser)
    bssidBytes.copy(header, 10); // Address2 (unused by the parser)
    bssidBytes.copy(header, 16); // Address3 = BSSID, what the parser reads

    const fixedParams = Buffer.alloc(12); // timestamp(8) + interval(2) + capability(2)
    const body = Buffer.concat([header, fixedParams, ssidIe, channelIe, rsnIe]);

    const globalHeader = Buffer.alloc(24);
    globalHeader.writeUInt32LE(0xa1b2c3d4, 0);
    globalHeader.writeUInt16LE(2, 4);
    globalHeader.writeUInt16LE(4, 6);
    globalHeader.writeUInt32LE(65535, 16);
    globalHeader.writeUInt32LE(105, 20); // LINKTYPE_IEEE802_11

    const recordHeader = Buffer.alloc(16);
    recordHeader.writeUInt32LE(body.length, 8);
    recordHeader.writeUInt32LE(body.length, 12);

    return Buffer.concat([globalHeader, recordHeader, body]);
  }

  it("has 'safe' risk level even with captureFilePath (offline parsing only)", () => {
    const tool = createSecurityScanWifiTool();
    expect(tool.riskLevel).toBe("safe");
  });

  it("extracts an open network's SSID/channel/encryption from a beacon frame", async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, "capture.pcap");
      await fs.writeFile(filePath, buildPcapWithBeacon({ ssid: "OpenNet", bssid: "aa:bb:cc:dd:ee:ff", channel: 11, privacy: false, rsn: false }));
      const tool = createSecurityScanWifiTool();
      const result = await tool.handler({ captureFilePath: filePath }, ctx);
      expect(result.isError).toBe(false);
      expect(result.content).toContain("OpenNet");
      expect(result.content).toMatch(/no encryption \(open network\)/i);
      const networks = result.metadata?.networks as Array<{ ssid: string; channel?: string; security: string }>;
      expect(networks).toHaveLength(1);
      expect(networks[0]).toMatchObject({ ssid: "OpenNet", channel: "11", security: "open" });
    });
  });

  it("extracts a WPA2 network (RSN element) and flags a hidden SSID", async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, "capture.pcap");
      await fs.writeFile(filePath, buildPcapWithBeacon({ ssid: "", bssid: "11:22:33:44:55:66", channel: 6, privacy: true, rsn: true }));
      const tool = createSecurityScanWifiTool();
      const result = await tool.handler({ captureFilePath: filePath }, ctx);
      expect(result.isError).toBe(false);
      expect(result.content).toMatch(/Hidden SSID/i);
      const networks = result.metadata?.networks as Array<{ security: string }>;
      expect(networks[0].security).toBe("wpa2");
    });
  });

  it("returns a clear error for a nonexistent capture file", async () => {
    const tool = createSecurityScanWifiTool();
    const result = await tool.handler({ captureFilePath: "/nonexistent/capture.pcap" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/failed to read capture file/i);
  });

  it("returns a clear error for a file that isn't a pcap", async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, "not-a-capture.txt");
      await fs.writeFile(filePath, "hello world");
      const tool = createSecurityScanWifiTool();
      const result = await tool.handler({ captureFilePath: filePath }, ctx);
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/unrecognized capture file/i);
    });
  });
});
