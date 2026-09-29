#!/usr/bin/env node
// Stands in for the real `gcloud` CLI's `gcloud auth configure-docker
// <registries> --quiet`.
const args = process.argv.slice(2);

if (args.length === 0) {
  process.exit(0); // isCommandAvailable probe
}

if (args.includes("--fail")) {
  console.error("ERROR: (gcloud.auth.configure-docker) You do not currently have an active account selected.");
  process.exit(1);
}

if (args[0] === "auth" && args[1] === "configure-docker") {
  console.log(`Docker configured to use ${args[2]} (args=${JSON.stringify(args)})`);
  process.exit(0);
}

console.error(`fake-gcloud: unrecognized args ${JSON.stringify(args)}`);
process.exit(2);
