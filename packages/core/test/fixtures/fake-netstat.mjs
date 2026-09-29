#!/usr/bin/env node
// Real, standalone process standing in for `netstat` — see
// secops-audit.test.ts (used as secops_audit_open_ports's fallback path
// when lsof isn't installed). Shaped like real macOS/BSD `netstat -an`.
const args = process.argv.slice(2);

if (args.length === 0) {
  // isCommandAvailable's "spawn with no args" probe.
  process.exit(0);
}

if (args.includes("-an")) {
  console.log("Active Internet connections (including servers)");
  console.log("Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)");
  console.log("tcp4       0      0  127.0.0.1.5432         *.*                    LISTEN");
  console.log("tcp4       0      0  10.0.0.5.51000         93.184.216.34.443      ESTABLISHED");
  console.log("udp4       0      0  *.5353                 *.*");
  process.exit(0);
}
process.exit(1);
