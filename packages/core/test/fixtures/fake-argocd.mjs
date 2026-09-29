#!/usr/bin/env node
// A real, standalone process standing in for the real `argocd` binary
// (unlikely to be installed in this sandbox — no real ArgoCD server to
// point it at anyway). Reproduces enough of argocd's real argv/exit-code
// shape (`argocd app sync|get|list`) to test argocd.ts's wrapper logic
// for real: real argv received, real exit code, real stdout/stderr.
const args = process.argv.slice(2);

if (args.length === 0) {
  // isCommandAvailable's "spawn with no args" probe.
  process.exit(0);
}

if (args.includes("--fail")) {
  console.error("FATA[0000] rpc error: code = NotFound desc = app 'missing-app' not found");
  process.exit(1);
}

const [group, verb, ...rest] = args;
console.log(`real args received: ${JSON.stringify(args)}`);
if (group === "app" && verb === "sync") {
  console.log(`Name: ${rest[0]}\nSync Status: Synced\nHealth Status: Healthy`);
} else if (group === "app" && verb === "get") {
  console.log(`Name: ${rest[0]}\nSync Status: Synced\nHealth Status: Healthy`);
} else if (group === "app" && verb === "list") {
  console.log("NAME   CLUSTER   NAMESPACE  PROJECT  STATUS  HEALTH\nmy-app https://x default    default  Synced  Healthy");
}
process.exit(0);
