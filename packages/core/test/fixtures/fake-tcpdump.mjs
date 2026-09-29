#!/usr/bin/env node
// Stands in for `tcpdump`/`dumpcap` for wifi-capture passive tests. Writes a
// minimal, structurally valid classic-pcap file (global header + a handful
// of fake packet records) to the path given after `-w`, then exits — same
// as tcpdump does when given a packet count (`-c`) on a finite capture.
import fs from "node:fs";

const args = process.argv.slice(2);
const wIndex = args.indexOf("-w");
const outPath = wIndex >= 0 ? args[wIndex + 1] : null;

if (!outPath) {
  console.error("fake-tcpdump: missing -w <file>");
  process.exit(1);
}

const buffers = [];
const header = Buffer.alloc(24);
header.writeUInt32LE(0xa1b2c3d4, 0); // magic (classic pcap, native endianness)
header.writeUInt16LE(2, 4); // version major
header.writeUInt16LE(4, 6); // version minor
header.writeInt32LE(0, 8); // thiszone
header.writeUInt32LE(0, 12); // sigfigs
header.writeUInt32LE(65535, 16); // snaplen
header.writeUInt32LE(105, 20); // linktype: LINKTYPE_IEEE802_11
buffers.push(header);

for (let i = 0; i < 3; i++) {
  const payload = Buffer.from(`fake-802.11-frame-${i}`);
  const rec = Buffer.alloc(16 + payload.length);
  rec.writeUInt32LE(1_700_000_000 + i, 0);
  rec.writeUInt32LE(0, 4);
  rec.writeUInt32LE(payload.length, 8);
  rec.writeUInt32LE(payload.length, 12);
  payload.copy(rec, 16);
  buffers.push(rec);
}

fs.writeFileSync(outPath, Buffer.concat(buffers));
process.exit(0);
