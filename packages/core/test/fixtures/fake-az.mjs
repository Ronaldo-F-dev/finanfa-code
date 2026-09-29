#!/usr/bin/env node
// Stands in for the real `az` CLI's `az acr login --name <registryName>`.
const args = process.argv.slice(2);

if (args.length === 0) {
  process.exit(0); // isCommandAvailable probe
}

if (args.includes("--fail")) {
  console.error("ERROR: Please run 'az login' to setup account.");
  process.exit(1);
}

if (args[0] === "acr" && args[1] === "login") {
  console.log(`Login Succeeded (args=${JSON.stringify(args)})`);
  process.exit(0);
}

console.error(`fake-az: unrecognized args ${JSON.stringify(args)}`);
process.exit(2);
