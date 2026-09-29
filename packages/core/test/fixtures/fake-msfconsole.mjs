#!/usr/bin/env node
// A real, standalone process standing in for the real `msfconsole` binary
// — see metasploit.test.ts for why (Metasploit may not be installed in
// this sandbox). Reproduces enough of msfconsole's real `-q -x "<cmds>"`
// argv shape to test security_run_metasploit's wrapper logic for real.
const args = process.argv.slice(2);

if (args.length === 0) {
  // isCommandAvailable's "spawn with no args" probe.
  process.exit(0);
}

const xIndex = args.indexOf("-x");
const commandString = xIndex !== -1 ? args[xIndex + 1] : undefined;

if (commandString === "sleep-forever") {
  // Never resolves on its own — used to test the tool's timeout handling.
  setInterval(() => {}, 1000);
} else if (commandString === "fail") {
  console.error("real msfconsole error: module not found");
  process.exit(1);
} else {
  console.log("Metasploit fake console started");
  console.log(`real -x command received: ${JSON.stringify(commandString)}`);
  console.log("real args received: " + JSON.stringify(args));
  process.exit(0);
}
