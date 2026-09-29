#!/usr/bin/env node
// A real, standalone process standing in for the real `nginx` binary — see
// nginx-config.test.ts for why (nginx may not be installed in this
// sandbox). Reproduces enough of `nginx -t -c <path>` real behavior to
// test test_nginx_config's wrapper logic for real: reads the real config
// file it's pointed at, and reports valid/invalid the same way real nginx
// does (exit 0 + "test is successful" on stderr, or exit 1 + an error
// message on stderr).
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);

if (args.length === 0) {
  // isCommandAvailable's "spawn with no args" probe.
  process.exit(0);
}

const cIndex = args.indexOf("-c");
const configPath = cIndex !== -1 ? args[cIndex + 1] : undefined;

if (!configPath) {
  console.error("nginx: [emerg] no -c <path> given to fake nginx");
  process.exit(1);
}

let content;
try {
  content = readFileSync(configPath, "utf-8");
} catch (err) {
  console.error(`nginx: [emerg] open() "${configPath}" failed (${err.message})`);
  process.exit(1);
}

// Minimal, deliberately simple validity check: balanced braces and an
// http {} block present — enough for the test's "valid vs invalid" cases
// without reimplementing real nginx's actual config parser.
const opens = (content.match(/{/g) || []).length;
const closes = (content.match(/}/g) || []).length;

if (opens !== closes || !content.includes("http")) {
  console.error(`nginx: [emerg] unexpected end of file, expecting "}" in ${configPath}`);
  process.exit(1);
}

console.error(`nginx: the configuration file ${configPath} syntax is ok`);
console.error(`nginx: configuration file ${configPath} test is successful`);
process.exit(0);
