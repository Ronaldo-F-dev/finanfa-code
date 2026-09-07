#!/usr/bin/env node
// A real, standalone process standing in for the real mydevops binary
// (which is snap-packaged and doesn't run inside this project's own dev
// sandbox — see mydevops.ts's header comment). Reproduces just enough of
// a real CLI's argv/exit-code/stdout/stderr contract for run_mydevops's
// wrapper logic (argv passthrough, cwd, exit code -> isError) to be
// tested for real, without ever depending on the actual mydevops binary
// being runnable in a given test environment.
const args = process.argv.slice(2);
const subcommand = args[0];

if (subcommand === "whoami") {
  console.log(`cwd=${process.cwd()}`);
  console.log(`args=${JSON.stringify(args)}`);
  process.exit(0);
}

if (subcommand === "destroy") {
  console.error("Error: refusing to destroy without --confirm");
  process.exit(1);
}

console.log(`ran: ${args.join(" ")}`);
process.exit(0);
