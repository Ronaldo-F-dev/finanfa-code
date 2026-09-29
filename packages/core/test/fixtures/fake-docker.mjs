#!/usr/bin/env node
// Stands in for the real `docker` CLI, specifically for
// docker_registry_login's ECR flow: `docker login --username AWS
// --password-stdin <registryUrl>`, reading the password from stdin (the
// real `aws ecr get-login-password | docker login ...` pipe) rather than
// argv, so a real password never appears on a shell command line.
const args = process.argv.slice(2);

if (args.length === 0) {
  process.exit(0); // isCommandAvailable probe
}

if (args[0] === "login") {
  let stdin = "";
  process.stdin.on("data", (d) => (stdin += d));
  process.stdin.on("end", () => {
    const registryUrl = args[args.length - 1] ?? "";
    if (registryUrl.includes("fail-account")) {
      console.error("Error response from daemon: Get \"https://index.docker.io/v1/users/\": unauthorized: incorrect username or password");
      process.exit(1);
    }
    console.log(`Login Succeeded (password-stdin=${JSON.stringify(stdin.trim())}, args=${JSON.stringify(args)})`);
    process.exit(0);
  });
} else {
  console.log(`real args received: ${JSON.stringify(args)}`);
  process.exit(0);
}
