#!/usr/bin/env node
import { main } from "../src/cli.js";

main(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
