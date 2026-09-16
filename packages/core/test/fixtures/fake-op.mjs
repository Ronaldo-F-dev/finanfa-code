#!/usr/bin/env node
// Stands in for the real 1Password CLI (`op`) — reproduces just enough
// of `op read <reference>`'s argv/exit-code/stdout/stderr contract for
// read_1password_secret's wrapper logic to be tested for real.
const args = process.argv.slice(2);
const [subcommand, reference] = args;

if (subcommand === "read") {
  if (reference === "op://Personal/Missing/field") {
    console.error(`[ERROR] 2024/01/01 00:00:00 "op://Personal/Missing/field" isn't a secret reference`);
    process.exit(1);
  }
  console.log(`secret-value-for-${reference}`);
  process.exit(0);
}

console.error(`fake-op: unknown subcommand ${subcommand}`);
process.exit(1);
