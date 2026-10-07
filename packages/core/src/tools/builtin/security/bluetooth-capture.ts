import fs from "node:fs/promises";
import type { ToolDefinition } from "../../../core/types.js";

// Offline btsnoop (HCI snoop log) analysis, ported from wireless-lab's
// bluetooth/analyzer package. btsnoop is the standard HCI-traffic capture
// format BlueZ (`btmon -w`) and Android write — analogous to pcap, but for
// HCI (host<->controller) traffic rather than 802.11 frames, so this is a
// separate tool from security_scan_bluetooth rather than a sub-action of
// it: the output shape (packet direction/type mix, HCI event codes seen)
// doesn't map onto "devices discovered" at all. No live capture, no radio
// access — just parsing bytes already on disk.

export const BTSNOOP_MAGIC = "btsnoop\0";

export class UnsupportedBtsnoopFormatError extends Error {}

export interface BtsnoopRecord {
  originalLength: number;
  includedLength: number;
  direction: "sent" | "received";
  packetType: "data" | "command-or-event";
  data: Buffer;
}

export interface BtsnoopFile {
  version: number;
  datalinkType: number;
  records: BtsnoopRecord[];
}

/** Format: 8-byte magic ("btsnoop\0"), 4-byte version, 4-byte datalink type
 * (all big-endian), then a sequence of records: original length(4) +
 * included length(4) + flags(4) + cumulative drops(4) + timestamp(8) +
 * payload, all big-endian. Flags bit 0: sent/received; bit 1: data vs
 * command/event packet. */
export function parseBtsnoop(buffer: Buffer): BtsnoopFile {
  if (buffer.length < 16 || buffer.toString("ascii", 0, 8) !== BTSNOOP_MAGIC) {
    throw new UnsupportedBtsnoopFormatError("Not a btsnoop file (missing 'btsnoop\\0' magic).");
  }
  const version = buffer.readUInt32BE(8);
  const datalinkType = buffer.readUInt32BE(12);

  const records: BtsnoopRecord[] = [];
  let offset = 16;
  while (offset + 24 <= buffer.length) {
    const originalLength = buffer.readUInt32BE(offset);
    const includedLength = buffer.readUInt32BE(offset + 4);
    const flags = buffer.readUInt32BE(offset + 8);
    const dataStart = offset + 24;
    const dataEnd = dataStart + includedLength;
    if (dataEnd > buffer.length) break; // truncated final record
    records.push({
      originalLength,
      includedLength,
      direction: (flags & 0x01) === 0 ? "sent" : "received",
      packetType: (flags & 0x02) === 0 ? "data" : "command-or-event",
      data: buffer.subarray(dataStart, dataEnd),
    });
    offset = dataEnd;
  }

  return { version, datalinkType, records };
}

interface SecurityAnalyzeBluetoothCaptureInput {
  filePath: string;
}

export function createSecurityAnalyzeBluetoothCaptureTool(): ToolDefinition<SecurityAnalyzeBluetoothCaptureInput> {
  return {
    name: "security_analyze_bluetooth_capture",
    description:
      "Analyzes an already-captured Bluetooth HCI snoop (btsnoop) file, the format BlueZ's `btmon -w` and " +
      "Android write, summarizing packet direction (sent/received) and type (data vs command/event) counts, " +
      "plus which HCI event codes appear (byte 0 of each received command-or-event packet). Offline file " +
      "parsing only: no live capture, no radio access. Useful for spotting unexpected command/event traffic in " +
      "a captured session.",
    riskLevel: "safe",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "Path to a .btsnoop / .cfa / .log HCI snoop capture file (e.g. from `btmon -w`)" },
      },
      required: ["filePath"],
    },
    describeCall: (input) => `analyze Bluetooth capture file ${input.filePath}`,
    async handler(input) {
      let buffer: Buffer;
      try {
        buffer = await fs.readFile(input.filePath);
      } catch (err) {
        return { content: `Failed to read capture file "${input.filePath}": ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }

      let parsed: BtsnoopFile;
      try {
        parsed = parseBtsnoop(buffer);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        return { content: `Failed to parse "${input.filePath}": ${detail}`, isError: true };
      }

      let sent = 0;
      let received = 0;
      let commandOrEvent = 0;
      let data = 0;
      const eventCodes = new Set<number>();
      for (const record of parsed.records) {
        if (record.direction === "sent") sent++;
        else received++;
        if (record.packetType === "command-or-event") {
          commandOrEvent++;
          if (record.direction === "received" && record.data.length >= 1) eventCodes.add(record.data[0]);
        } else {
          data++;
        }
      }

      const summary = {
        filePath: input.filePath,
        totalPackets: parsed.records.length,
        sentPackets: sent,
        receivedPackets: received,
        commandOrEventPackets: commandOrEvent,
        dataPackets: data,
        eventCodesSeen: [...eventCodes].sort((a, b) => a - b),
      };

      const content =
        `Parsed ${parsed.records.length} btsnoop record(s) from "${input.filePath}" (datalink type ${parsed.datalinkType}):\n` +
        `- sent: ${sent}, received: ${received}\n` +
        `- data packets: ${data}, command/event packets: ${commandOrEvent}\n` +
        `- HCI event codes seen: ${summary.eventCodesSeen.length > 0 ? summary.eventCodesSeen.map((c) => `0x${c.toString(16).padStart(2, "0")}`).join(", ") : "(none)"}`;

      return { content, isError: false, metadata: { summary } };
    },
  };
}
