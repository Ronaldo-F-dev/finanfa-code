#!/usr/bin/env node
// A real, standalone process standing in for Linux's `nmcli` — see
// wifi-scan.test.ts. Reproduces nmcli's terse (-t) colon-separated output
// shape closely enough to test the real parsing logic.
const args = process.argv.slice(2);

if (args.length === 0) {
  process.exit(0);
}

if (args.join(" ") === "-t -f SSID,BSSID,CHAN,SIGNAL,SECURITY device wifi list") {
  console.log("HomeNetwork:12\\:34\\:56\\:78\\:9A\\:BC:6:80:WPA2");
  console.log("CoffeeShop:DE\\:AD\\:BE\\:EF\\:00\\:01:11:40:");
  console.log("OldRouter:AA\\:BB\\:CC\\:DD\\:EE\\:FF:1:20:WEP");
  process.exit(0);
}

console.error(`fake-nmcli: unrecognized args ${JSON.stringify(args)}`);
process.exit(1);
