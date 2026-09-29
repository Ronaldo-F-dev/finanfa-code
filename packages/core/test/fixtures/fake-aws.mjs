#!/usr/bin/env node
// Stands in for the real `aws` CLI's `aws ecr get-login-password --region
// <region>` call — real argv received, prints a fake token to stdout the
// same shape a real login password would take.
const args = process.argv.slice(2);

if (args.length === 0) {
  process.exit(0); // isCommandAvailable probe
}

if (args.includes("--fail")) {
  console.error("An error occurred (UnrecognizedClientException) when calling the GetAuthorizationToken operation: The security token included in the request is invalid.");
  process.exit(1);
}

if (args[0] === "ecr" && args[1] === "get-login-password") {
  console.log("fake-ecr-login-password-token");
  process.exit(0);
}

console.error(`fake-aws: unrecognized args ${JSON.stringify(args)}`);
process.exit(2);
