#!/usr/bin/env node
// Real, standalone process standing in for `lsof` — see secops-audit.test.ts.
// Reproduces the real column shape of `lsof -iTCP -sTCP:LISTEN -P -n` and
// `lsof -iUDP -P -n` output for secops_audit_open_ports's parser.
const args = process.argv.slice(2);

if (args.length === 0) {
  // isCommandAvailable's "spawn with no args" probe.
  process.exit(0);
}

if (args.includes("-iTCP")) {
  console.log("COMMAND     PID    USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME");
  console.log("redis-ser   529 renaldo   12u  IPv4 0x6604de87e7fa33b2      0t0  TCP 127.0.0.1:6379 (LISTEN)");
  console.log("node      17121 renaldo   16u  IPv6 0xf2329eeab8f03b1e      0t0  TCP *:61035 (LISTEN)");
  process.exit(0);
} else if (args.includes("-iUDP")) {
  console.log("COMMAND     PID    USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME");
  console.log("mdnsd       200 renaldo    3u  IPv4 0x1234567890abcdef      0t0  UDP *:5353");
  process.exit(0);
}
process.exit(1);
