#!/usr/bin/env node
// Stands in for the real HashiCorp Vault CLI (`vault`) — reproduces just
// enough of `vault kv get -field=<field> <path>`'s argv/exit-code/stdout/
// stderr contract for read_vault_secret's wrapper logic to be tested for
// real.
const args = process.argv.slice(2);
const [subcommand, action, fieldArg, path] = args;

if (subcommand === "kv" && action === "get") {
  const field = fieldArg?.replace(/^-field=/, "");
  if (path === "secret/missing") {
    console.error(`No value found at secret/data/missing`);
    process.exit(2);
  }
  console.log(`vault-value-for-${path}-${field}`);
  process.exit(0);
}

console.error(`fake-vault: unexpected args ${args.join(" ")}`);
process.exit(1);
