#!/usr/bin/env node
// Stands in for Linux's `iw` for platform Wi-Fi interface enumeration tests.
const args = process.argv.slice(2);
const joined = args.join(" ");

if (joined === "dev") {
  console.log("phy#0");
  console.log("\tInterface wlan0");
  console.log("\t\tifindex 3");
  console.log("\t\ttype managed");
  process.exit(0);
}

if (joined === "phy phy0 info") {
  console.log("Wiphy phy0");
  console.log("\tSupported interface modes:");
  console.log("\t\t * IBSS");
  console.log("\t\t * managed");
  console.log("\t\t * AP");
  console.log("\t\t * monitor");
  process.exit(0);
}

console.error(`fake-iw: unrecognized args ${JSON.stringify(args)}`);
process.exit(1);
