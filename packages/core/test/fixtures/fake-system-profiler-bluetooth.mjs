#!/usr/bin/env node
// A real, standalone process standing in for macOS's `system_profiler
// SPBluetoothDataType -json` — see bluetooth-scan.test.ts.
const args = process.argv.slice(2);

if (args.length === 0) {
  process.exit(0);
}

if (args[0] === "SPAirPortDataType" && args[1] === "-json") {
  console.log(
    JSON.stringify({
      SPAirPortDataType: [
        {
          spairport_airport_interfaces: [
            {
              spairport_current_network_information: {
                _name: "HomeNetwork",
                spairport_security_mode: "spairport_security_mode_wpa2_personal",
                spairport_network_channel: "6",
                spairport_signal_noise: "-45 dBm / -90 dBm",
              },
            },
          ],
        },
      ],
    }),
  );
  process.exit(0);
}

if (args[0] === "SPBluetoothDataType" && args[1] === "-json") {
  console.log(
    JSON.stringify({
      SPBluetoothDataType: [
        {
          device_connected: [
            { "AirPods Pro": { device_address: "11-22-33-44-55-66", device_isconnected: "attrib_Yes" } },
          ],
          device_not_connected: [
            { "Old Keyboard": { device_address: "aa-bb-cc-dd-ee-ff" } },
          ],
        },
      ],
    }),
  );
  process.exit(0);
}

console.error(`fake-system-profiler-bluetooth: unrecognized args ${JSON.stringify(args)}`);
process.exit(1);
