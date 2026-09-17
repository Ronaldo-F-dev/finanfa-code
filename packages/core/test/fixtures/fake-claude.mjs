#!/usr/bin/env node
// A real, standalone process standing in for the real Claude Code CLI
// (`claude`) — reproduces just enough of a real CLI's argv/exit-code/
// stdout/stderr contract for delegate_to_claude_code's wrapper logic
// (argv passthrough, cwd, exit code -> isError) to be tested for real,
// without ever actually spawning a live, recursive coding-agent session.
const args = process.argv.slice(2);

if (args[0] === "-p") {
  console.log(`cwd=${process.cwd()}`);
  console.log(`args=${JSON.stringify(args)}`);
  process.exit(0);
}

if (args[0] === "--fail") {
  console.error("Error: simulated delegated task failure");
  process.exit(1);
}

console.log(`ran: ${args.join(" ")}`);
process.exit(0);
