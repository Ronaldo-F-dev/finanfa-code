#!/usr/bin/env node
// A real, standalone process standing in for the real `terraform` binary
// (unlikely to be installed in this sandbox — no real cloud provider to
// point it at anyway). Reproduces enough of terraform's real argv/exit-code
// shape (init/plan/apply -auto-approve/destroy -auto-approve/output -json/
// validate) to test terraform.ts's wrapper logic for real: real argv
// received, real exit code, real stdout/stderr.
const args = process.argv.slice(2);

if (args.length === 0) {
  // isCommandAvailable's "spawn with no args" probe.
  process.exit(0);
}

if (args.includes("--fail")) {
  console.error("Error: no valid credential sources found for AWS provider");
  process.exit(1);
}

const [verb] = args;
console.log(`real args received: ${JSON.stringify(args)}`);
if (verb === "init") {
  console.log("Terraform has been successfully initialized!");
} else if (verb === "plan") {
  console.log("Plan: 1 to add, 0 to change, 0 to destroy.");
} else if (verb === "apply") {
  console.log("Apply complete! Resources: 1 added, 0 changed, 0 destroyed.");
} else if (verb === "destroy") {
  console.log("Destroy complete! Resources: 1 destroyed.");
} else if (verb === "output") {
  console.log('{"example_output":{"value":"hello","type":"string"}}');
} else if (verb === "validate") {
  console.log("Success! The configuration is valid.");
}
process.exit(0);
