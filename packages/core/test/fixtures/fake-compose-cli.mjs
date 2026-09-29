#!/usr/bin/env node
// A real, standalone process standing in for either form docker-registry.ts
// can invoke: the modern `docker compose ...` plugin subcommand (leading
// "compose" arg) or the legacy standalone `docker-compose ...` binary (no
// leading "compose" arg) — this fake accepts both shapes so the same
// fixture can stand in for either dockerBinary or dockerComposeBinary in
// tests, and reproduces enough real argv/exit-code shape to test the
// wrapper logic for real. (Named distinctly from fake-docker-compose.mjs,
// which is a different fixture used by the monitoring-stack tools.)
const args = process.argv.slice(2);

if (args.length === 0) {
  // isCommandAvailable's "spawn with no args" probe.
  process.exit(0);
}

if (args.includes("--fail")) {
  console.error("Error: no configuration file provided: not found");
  process.exit(1);
}

console.log(`real args received: ${JSON.stringify(args)}`);
process.exit(0);
