#!/usr/bin/env node
// A real, standalone process standing in for the real macOS `system_profiler`
// binary — see usb-devices.test.ts (real system_profiler is macOS-only, so
// this suite runs on any CI platform against a fake stand-in shaped like
// real `system_profiler SPUSBDataType -json` output).
const args = process.argv.slice(2);

if (args.length === 0) {
  process.exit(0);
}

if (args[0] === "SPUSBDataType" && args[1] === "-json") {
  console.log(
    JSON.stringify({
      SPUSBDataType: [
        {
          _name: "USB 3.1 Bus",
          _items: [
            {
              _name: "iPhone",
              manufacturer: "Apple Inc.",
              product_id: "0x12a8",
              vendor_id: "0x05ac  (Apple Inc.)",
              serial_num: "00008030-0011ABCDEF12",
            },
            {
              _name: "USB2.0 Hub",
              _items: [
                {
                  _name: "USB Storage Device",
                  manufacturer: "Generic",
                  product_id: "0x5678",
                  vendor_id: "0x1234",
                },
              ],
            },
          ],
        },
      ],
    }),
  );
  process.exit(0);
}

console.error(`fake-system-profiler: unrecognized args ${JSON.stringify(args)}`);
process.exit(1);
