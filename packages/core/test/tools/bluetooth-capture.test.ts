import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createSecurityAnalyzeBluetoothCaptureTool } from "../../src/tools/builtin/security/bluetooth-capture.js";

const ctx = { cwd: "/tmp", sessionId: "s", signal: new AbortController().signal };

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bt-capture-test-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** Builds a minimal btsnoop file: 16-byte global header ("btsnoop\0" magic +
 * version + datalink type, all big-endian) then a sequence of 24-byte
 * record headers + payload. */
function buildBtsnoopFile(records: Array<{ flags: number; data: Buffer }>): Buffer {
  const header = Buffer.alloc(16);
  header.write("btsnoop\0", 0, "ascii");
  header.writeUInt32BE(1, 8);
  header.writeUInt32BE(1002, 12); // HCI UART datalink type
  const parts: Buffer[] = [header];
  for (const record of records) {
    const recHeader = Buffer.alloc(24);
    recHeader.writeUInt32BE(record.data.length, 0);
    recHeader.writeUInt32BE(record.data.length, 4);
    recHeader.writeUInt32BE(record.flags, 8);
    recHeader.writeUInt32BE(0, 12);
    parts.push(recHeader, record.data);
  }
  return Buffer.concat(parts);
}

describe("security_analyze_bluetooth_capture (real btsnoop file parsing, ported from wireless-lab)", () => {
  it("has 'safe' risk level (offline file parsing only)", () => {
    const tool = createSecurityAnalyzeBluetoothCaptureTool();
    expect(tool.riskLevel).toBe("safe");
  });

  it("returns a clear error for a nonexistent capture file", async () => {
    const tool = createSecurityAnalyzeBluetoothCaptureTool();
    const result = await tool.handler({ filePath: "/nonexistent/file.log" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/failed to read capture file/i);
  });

  it("returns a clear error for a file missing the btsnoop magic", async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, "not-btsnoop.log");
      await fs.writeFile(filePath, "not a btsnoop file");
      const tool = createSecurityAnalyzeBluetoothCaptureTool();
      const result = await tool.handler({ filePath }, ctx);
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/not a btsnoop file/i);
    });
  });

  it("summarizes a real btsnoop file's direction/type mix and HCI event codes", async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, "capture.btsnoop");
      await fs.writeFile(
        filePath,
        buildBtsnoopFile([
          { flags: 0b00, data: Buffer.from([0x01, 0x02]) }, // sent, data
          { flags: 0b11, data: Buffer.from([0x3e, 0x02]) }, // received, command/event
          { flags: 0b11, data: Buffer.from([0x0e, 0x04]) }, // received, command/event
        ]),
      );
      const tool = createSecurityAnalyzeBluetoothCaptureTool();
      const result = await tool.handler({ filePath }, ctx);
      expect(result.isError).toBe(false);
      const summary = result.metadata?.summary as {
        totalPackets: number;
        sentPackets: number;
        receivedPackets: number;
        commandOrEventPackets: number;
        dataPackets: number;
        eventCodesSeen: number[];
      };
      expect(summary.totalPackets).toBe(3);
      expect(summary.sentPackets).toBe(1);
      expect(summary.receivedPackets).toBe(2);
      expect(summary.dataPackets).toBe(1);
      expect(summary.commandOrEventPackets).toBe(2);
      expect(summary.eventCodesSeen).toEqual([0x0e, 0x3e]);
      expect(result.content).toMatch(/0x0e, 0x3e/);
    });
  });
});
