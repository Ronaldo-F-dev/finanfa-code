import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createSecurityStartWifiCaptureTool, createSecurityListWifiCapturesTool, listWifiInterfacesLinux } from "../../src/tools/builtin/security/wifi-capture.js";
import { resetCommandAvailabilityCacheForTests } from "../../src/util/command-availability.js";

const ctx = { cwd: "/tmp", sessionId: "s", signal: new AbortController().signal };
const FAKE_TCPDUMP = fileURLToPath(new URL("../fixtures/fake-tcpdump.mjs", import.meta.url));
const FAKE_IW = fileURLToPath(new URL("../fixtures/fake-iw.mjs", import.meta.url));
const MISSING_BIN = "/nonexistent/definitely-not-a-real-binary-xyz";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wifi-capture-tool-test-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe("security_start_wifi_capture (real tcpdump subprocess, fake binary, ported from wireless-lab)", () => {
  it("has 'ask' risk level (spawns a real subprocess that writes a file to disk)", () => {
    const tool = createSecurityStartWifiCaptureTool();
    expect(tool.riskLevel).toBe("ask");
  });

  it("reports tcpdump missing rather than crashing", async () => {
    resetCommandAvailabilityCacheForTests();
    const tool = createSecurityStartWifiCaptureTool({ tcpdumpBinary: MISSING_BIN });
    const result = await tool.handler({ interfaceName: "wlan0" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/tcpdump not found/i);
  });

  it("runs a capture, writing a real .pcap file plus a JSON metadata sidecar", async () => {
    await withTempDir(async (dir) => {
      resetCommandAvailabilityCacheForTests();
      const tool = createSecurityStartWifiCaptureTool({ tcpdumpBinary: FAKE_TCPDUMP });
      const result = await tool.handler({ interfaceName: "wlan0", outputDir: dir, packetCount: 3 }, ctx);
      expect(result.isError).toBe(false);
      const capture = result.metadata?.capture as { id: string; filePath: string; fileSizeBytes: number };
      expect(capture.fileSizeBytes).toBeGreaterThan(0);
      const fileStat = await fs.stat(capture.filePath);
      expect(fileStat.size).toBe(capture.fileSizeBytes);
      const sidecar = JSON.parse(await fs.readFile(`${capture.filePath}.meta.json`, "utf-8"));
      expect(sidecar.id).toBe(capture.id);
      expect(sidecar.interfaceName).toBe("wlan0");
    });
  });
});

describe("security_list_wifi_captures (real filesystem listing)", () => {
  it("has 'safe' risk level (pure filesystem read)", () => {
    const tool = createSecurityListWifiCapturesTool();
    expect(tool.riskLevel).toBe("safe");
  });

  it("reports no captures found in an empty/nonexistent directory", async () => {
    const tool = createSecurityListWifiCapturesTool();
    const result = await tool.handler({ outputDir: "/nonexistent/capture-dir" }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toMatch(/no captures found/i);
  });

  it("lists a capture previously written by security_start_wifi_capture", async () => {
    await withTempDir(async (dir) => {
      resetCommandAvailabilityCacheForTests();
      const startTool = createSecurityStartWifiCaptureTool({ tcpdumpBinary: FAKE_TCPDUMP });
      const startResult = await startTool.handler({ interfaceName: "wlan0", outputDir: dir, packetCount: 3 }, ctx);
      const capture = startResult.metadata?.capture as { id: string };

      const listTool = createSecurityListWifiCapturesTool();
      const listResult = await listTool.handler({ outputDir: dir }, ctx);
      expect(listResult.isError).toBe(false);
      expect(listResult.content).toContain(capture.id);
      const captures = listResult.metadata?.captures as unknown[];
      expect(captures).toHaveLength(1);
    });
  });
});

describe("listWifiInterfacesLinux (real `iw` subprocess, fake binary, ported from wireless-lab)", () => {
  it("returns an empty list when `iw` isn't installed", async () => {
    resetCommandAvailabilityCacheForTests();
    const interfaces = await listWifiInterfacesLinux(MISSING_BIN);
    expect(interfaces).toEqual([]);
  });

  it("detects a monitor-mode-capable interface via `iw dev` + `iw phy ... info`", async () => {
    resetCommandAvailabilityCacheForTests();
    const interfaces = await listWifiInterfacesLinux(FAKE_IW);
    expect(interfaces).toHaveLength(1);
    expect(interfaces[0]).toMatchObject({ name: "wlan0", supportsMonitorMode: true });
  });
});
