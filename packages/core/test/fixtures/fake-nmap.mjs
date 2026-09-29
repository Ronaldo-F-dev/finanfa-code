#!/usr/bin/env node
// A real, standalone process standing in for the real `nmap` binary — see
// nmap.test.ts for why (nmap may not be installed in this sandbox).
// Reproduces enough of nmap's real argv/output shape to test
// security_run_nmap's wrapper logic for real: real argv received, real
// exit code, real stdout/stderr.
const args = process.argv.slice(2);

if (args.length === 0) {
  // isCommandAvailable's "spawn with no args" probe.
  process.exit(0);
}

if (args.includes("--sleep-forever")) {
  // Never resolves on its own — used to test the tool's timeout handling.
  setInterval(() => {}, 1000);
} else if (args.includes("--fail")) {
  console.error("real nmap error: something went wrong");
  process.exit(1);
} else {
  console.log(`Starting Nmap fake scan`);
  console.log(`real args received: ${JSON.stringify(args)}`);
  console.log(`Nmap done: scan complete`);
  process.exit(0);
}
