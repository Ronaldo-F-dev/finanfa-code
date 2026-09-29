#!/usr/bin/env node
// Stands in for the real `docker` CLI's `compose` subcommand — reproduces
// just enough of `docker compose -f <file> up -d` / `down`'s argv/exit-
// code/stdout contract for start_monitoring_stack/stop_monitoring_stack's
// wrapper logic to be tested for real, without depending on a real Docker
// daemon being available in every environment this runs in.
import { existsSync } from "node:fs";

const args = process.argv.slice(2);
const [subcommand, flag, file, action] = args;

if (subcommand !== "compose") {
  console.error(`fake-docker-compose: expected "compose" as the first arg, got ${JSON.stringify(args)}`);
  process.exit(1);
}

if (flag !== "-f" || !file) {
  console.error(`fake-docker-compose: expected -f <file>, got ${JSON.stringify(args)}`);
  process.exit(1);
}

if (!existsSync(file)) {
  console.error(`fake-docker-compose: no such file: ${file} (cwd: ${process.cwd()})`);
  process.exit(1);
}

if (action === "up") {
  console.log(`Creating containers from ${file} (${process.cwd()})`);
  process.exit(0);
}

if (action === "down") {
  console.log(`Stopping containers from ${file} (${process.cwd()})`);
  process.exit(0);
}

console.error(`fake-docker-compose: unexpected args ${JSON.stringify(args)}`);
process.exit(1);
