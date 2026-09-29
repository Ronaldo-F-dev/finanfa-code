#!/usr/bin/env node
// A real, standalone process standing in for macOS's `airport` utility —
// see wifi-scan.test.ts (the real airport binary is macOS-only, and Apple
// has removed it entirely on some macOS versions, so this suite runs
// against a fake stand-in shaped like real `airport -s` output).
const args = process.argv.slice(2);

if (args.length === 0) {
  // isCommandAvailable's "spawn with no args" probe.
  process.exit(0);
}

if (args[0] === "-s") {
  console.log("                            SSID BSSID             RSSI CHANNEL HT CC SECURITY");
  console.log("                      HomeNetwork 12:34:56:78:9a:bc -45  6       Y  US WPA2(PSK/AES/AES)");
  console.log("                       CoffeeShop de:ad:be:ef:00:01 -70  11      Y  US NONE");
  console.log("                          OldRouter aa:bb:cc:dd:ee:ff -80  1       N  US WEP");
  process.exit(0);
}

console.error(`fake-airport: unrecognized args ${JSON.stringify(args)}`);
process.exit(1);
