// Offline .pcap capture-file analysis, ported from wireless-lab's
// wifi/analyzer package (classic-pcap reader + 802.11 beacon/probe-response
// parser). No live radio access here — just parsing bytes already on disk,
// so security_scan_wifi's captureFilePath sub-action can report on a Wi-Fi
// capture taken by an external tool (tcpdump, airodump-ng, Wireshark, ...).

export const PCAP_MAGIC_LE = 0xa1b2c3d4;
export const PCAP_MAGIC_BE = 0xd4c3b2a1;
export const PCAP_MAGIC_NS_LE = 0xa1b23c4d;
export const PCAPNG_MAGIC = 0x0a0d0d0a;

// LINKTYPE values relevant to Wi-Fi captures (tcpdump linktype registry).
export const LINKTYPE_IEEE802_11 = 105;
export const LINKTYPE_IEEE802_11_RADIOTAP = 127;

export interface PcapPacketRecord {
  capturedLength: number;
  data: Buffer;
}

export interface PcapFile {
  linkType: number;
  packets: PcapPacketRecord[];
}

export class UnsupportedCaptureFormatError extends Error {}

function detectMagic(buffer: Buffer): "pcap" | "pcapng" | "unknown" {
  if (buffer.length < 4) return "unknown";
  const magic = buffer.readUInt32LE(0);
  if (magic === PCAP_MAGIC_LE || magic === PCAP_MAGIC_BE || magic === PCAP_MAGIC_NS_LE) return "pcap";
  if (magic === PCAPNG_MAGIC) return "pcapng";
  return "unknown";
}

/** Parses a classic-pcap buffer fully into memory: global header (24 bytes),
 * then a sequence of (16-byte record header + payload) records. See
 * tcpdump's pcap-savefile(5). PCAPNG is detected and reported as
 * unsupported rather than silently misparsed. */
export function parsePcap(buffer: Buffer): PcapFile {
  const format = detectMagic(buffer);
  if (format === "pcapng") {
    throw new UnsupportedCaptureFormatError(
      "PCAPNG format detected. This analyzer supports classic pcap only, convert with `tcpdump -r in.pcapng -w out.pcap` or `editcap` first.",
    );
  }
  if (format === "unknown") {
    throw new UnsupportedCaptureFormatError("Unrecognized capture file: not a classic-pcap or pcapng magic number.");
  }
  if (buffer.length < 24) {
    throw new UnsupportedCaptureFormatError("File is too short to contain a valid pcap global header.");
  }

  const magic = buffer.readUInt32LE(0);
  const bigEndian = magic === PCAP_MAGIC_BE;
  const read32 = (offset: number) => (bigEndian ? buffer.readUInt32BE(offset) : buffer.readUInt32LE(offset));
  const linkType = read32(20);

  const packets: PcapPacketRecord[] = [];
  let offset = 24;
  while (offset + 16 <= buffer.length) {
    const capturedLength = read32(offset + 8);
    const dataStart = offset + 16;
    const dataEnd = dataStart + capturedLength;
    if (dataEnd > buffer.length) break; // truncated final record — stop rather than throw
    packets.push({ capturedLength, data: buffer.subarray(dataStart, dataEnd) });
    offset = dataEnd;
  }

  return { linkType, packets };
}

export interface BeaconFrame {
  bssid: string;
  ssid: string;
  channel?: number;
  frameType: "beacon" | "probe-response";
  hasRsnElement: boolean;
  hasWpaVendorElement: boolean;
  privacyBit: boolean;
}

function macToString(buffer: Buffer, offset: number): string {
  return Array.from(buffer.subarray(offset, offset + 6))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(":");
}

/** Radiotap header: version(1) + pad(1) + length(2 LE) + presence bitmask(s).
 * Only `length` (the total header size) is needed to skip past it to the
 * 802.11 frame itself. */
function stripRadiotapHeader(data: Buffer): Buffer | null {
  if (data.length < 4) return null;
  const length = data.readUInt16LE(2);
  if (length > data.length) return null;
  return data.subarray(length);
}

/** Parses a single 802.11 management frame's beacon/probe-response body
 * (fixed fields + tagged information elements) into a BeaconFrame, or null
 * if it isn't a beacon/probe-response, is too short, or is malformed. */
function parseManagementFrame(frame: Buffer): BeaconFrame | null {
  if (frame.length < 24) return null;
  const frameControl = frame.readUInt16LE(0);
  const type = (frameControl >> 2) & 0b11;
  const subtype = (frameControl >> 4) & 0b1111;
  const privacyBit = ((frameControl >> 8) & 0b01000000) !== 0;
  if (type !== 0) return null; // not a management frame
  const isBeacon = subtype === 8;
  const isProbeResponse = subtype === 5;
  if (!isBeacon && !isProbeResponse) return null;

  const bssid = macToString(frame, 16); // Address3 in beacon/probe-response
  const fixedParamsEnd = 24 + 12; // timestamp(8) + beacon interval(2) + capability(2)
  if (frame.length < fixedParamsEnd) return null;

  let ssid = "";
  let channel: number | undefined;
  let hasRsnElement = false;
  let hasWpaVendorElement = false;
  let offset = fixedParamsEnd;
  while (offset + 2 <= frame.length) {
    const elementId = frame[offset];
    const elementLen = frame[offset + 1];
    const valueStart = offset + 2;
    const valueEnd = valueStart + elementLen;
    if (valueEnd > frame.length) break;
    const value = frame.subarray(valueStart, valueEnd);
    if (elementId === 0) ssid = value.toString("utf-8");
    else if (elementId === 3 && value.length >= 1) channel = value[0];
    else if (elementId === 48) hasRsnElement = true;
    else if (elementId === 221 && value.length >= 4 && value[0] === 0x00 && value[1] === 0x50 && value[2] === 0xf2 && value[3] === 0x01) hasWpaVendorElement = true;
    offset = valueEnd;
  }

  return { bssid, ssid, channel, frameType: isBeacon ? "beacon" : "probe-response", hasRsnElement, hasWpaVendorElement, privacyBit };
}

/** Extracts beacon/probe-response frames from a pcap's packet records.
 * Supports LINKTYPE_IEEE802_11 (raw 802.11, no radio header) and
 * LINKTYPE_IEEE802_11_RADIOTAP (radiotap header prepended); anything else
 * yields no frames rather than misparsing. */
export function extractBeaconFrames(linkType: number, packets: PcapPacketRecord[]): BeaconFrame[] {
  const frames: BeaconFrame[] = [];
  for (const packet of packets) {
    let body: Buffer | null = packet.data;
    if (linkType === LINKTYPE_IEEE802_11_RADIOTAP) {
      body = stripRadiotapHeader(packet.data);
    } else if (linkType !== LINKTYPE_IEEE802_11) {
      continue;
    }
    if (!body) continue;
    const parsed = parseManagementFrame(body);
    if (parsed) frames.push(parsed);
  }
  return frames;
}
