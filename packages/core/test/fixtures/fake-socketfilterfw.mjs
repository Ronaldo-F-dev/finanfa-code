#!/usr/bin/env node
// Real, standalone process standing in for macOS's
// /usr/libexec/ApplicationFirewall/socketfilterfw — see secops-audit.test.ts.
const args = process.argv.slice(2);

if (args.length === 0) {
  // isCommandAvailable's "spawn with no args" probe.
  process.exit(0);
}

if (args.includes("--getglobalstate")) {
  const state = process.env.FAKE_FIREWALL_STATE ?? "enabled";
  console.log(state === "enabled" ? "Firewall is enabled. (State = 1)" : "Firewall is disabled. (State = 0)");
  process.exit(0);
}
process.exit(1);
