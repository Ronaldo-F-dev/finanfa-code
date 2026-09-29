#!/usr/bin/env node
// Real, standalone process standing in for Linux's `ufw` — see
// secops-audit.test.ts.
const args = process.argv.slice(2);

if (args.length === 0) {
  // isCommandAvailable's "spawn with no args" probe.
  process.exit(0);
}

if (args.includes("status")) {
  const state = process.env.FAKE_FIREWALL_STATE ?? "enabled";
  console.log(state === "enabled" ? "Status: active" : "Status: inactive");
  process.exit(0);
}
process.exit(1);
