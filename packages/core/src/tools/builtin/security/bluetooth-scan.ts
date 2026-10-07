import { spawn } from "node:child_process";
import type { ToolDefinition } from "../../../core/types.js";
import { isCommandAvailable } from "../../../util/command-availability.js";
import { severityFromScore } from "./cvss.js";
import { formatScanOutput, type Finding, type PassedControl, type ScanOutput } from "./types.js";
import { BluetoothctlSession, parseListAttributes, parseReadValue, auditGattAttributes, isValidMacAddress, isValidGattPath, type GattAttribute } from "./bluetooth-gatt.js";

// Real gap this fills: no Bluetooth recon at all in this directory. Scoped
// to surface-level discovery only — what's advertising/paired, by name,
// address and (where available) signal strength — using each OS's own
// standard tooling. Deliberately does NOT attempt BLE GATT-level enumeration
// or exploitation, and does NOT claim to determine a device's actual
// pairing security (Just Works vs passkey vs OOB) — that requires sniffing
// the pairing exchange itself, not just listing what's discoverable, so
// this tool reports discovery only and is explicit about that limit rather
// than fabricating a security verdict per device.
const SCAN_TIMEOUT_MS = 8_000;

export interface BluetoothDevice {
  name: string;
  address?: string;
  rssi?: string;
  paired?: boolean;
  connected?: boolean;
  raw: string;
}

interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
  error?: NodeJS.ErrnoException;
}

function run(bin: string, args: string[], timeoutMs = SCAN_TIMEOUT_MS): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(bin, args);
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout?.on("data", (d) => (stdout += d));
    child.stderr?.on("data", (d) => (stderr += d));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: null, error: error as NodeJS.ErrnoException });
    });
  });
}

// --- macOS: system_profiler (paired/connected) + blueutil (live inquiry) -

interface SpBluetoothDevice {
  device_name?: string;
  device_address?: string;
  device_isconnected?: string;
}

/** system_profiler nests each paired device as a { "<Display Name>": {...} } object rather than a name field, so devices come back as an array of single-key records. */
type SpBluetoothDeviceEntry = Record<string, SpBluetoothDevice>;

interface SpBluetoothController {
  device_title?: string;
  device_connected?: SpBluetoothDeviceEntry[];
  device_not_connected?: SpBluetoothDeviceEntry[];
}

async function scanMacSystemProfiler(bin: string): Promise<{ devices: BluetoothDevice[]; available: boolean; note: string }> {
  if (!isCommandAvailable(bin)) return { devices: [], available: false, note: "system_profiler not found (unexpected on macOS)." };
  const result = await run(bin, ["SPBluetoothDataType", "-json"]);
  if (result.code !== 0) return { devices: [], available: true, note: `system_profiler exited with an error: ${result.stderr.trim() || result.code}` };
  try {
    const parsed = JSON.parse(result.stdout) as { SPBluetoothDataType?: Array<Record<string, unknown>> };
    const devices: BluetoothDevice[] = [];
    for (const controller of parsed.SPBluetoothDataType ?? []) {
      // Apple's schema has changed shape across macOS versions; device
      // lists can appear directly on the top-level object or nested under
      // a controller entry, so both are checked defensively.
      const c = controller as SpBluetoothController;
      const connected = c.device_connected ?? [];
      const notConnected = c.device_not_connected ?? [];
      for (const entry of connected) {
        for (const [name, info] of Object.entries(entry)) {
          devices.push({ name, address: info.device_address, connected: true, paired: true, raw: JSON.stringify(entry) });
        }
      }
      for (const entry of notConnected) {
        for (const [name, info] of Object.entries(entry)) {
          devices.push({ name, address: info.device_address, connected: false, paired: true, raw: JSON.stringify(entry) });
        }
      }
    }
    return { devices, available: true, note: `system_profiler: ${devices.length} paired device(s) reported (paired/known devices only, not a live nearby scan).` };
  } catch (err) {
    return { devices: [], available: true, note: `Failed to parse system_profiler output: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** blueutil --inquiry <secs> prints one discovered device per line, e.g. `address: 00-11-22-33-44-55, not connected, not paired, rssi: -62, name: "Foo"`. */
function parseBlueutilInquiry(stdout: string): BluetoothDevice[] {
  const devices: BluetoothDevice[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const address = /address:\s*([0-9a-f-]+)/i.exec(line)?.[1];
    const rssi = /rssi:\s*(-?\d+)/i.exec(line)?.[1];
    const name = /name:\s*"([^"]*)"/i.exec(line)?.[1];
    const paired = /(?<!not )paired/.test(line);
    const connected = /(?<!not )connected/.test(line);
    if (!address && !name) continue;
    devices.push({ name: name ?? "(unnamed)", address, rssi: rssi ? `${rssi} dBm` : undefined, paired, connected, raw: line.trim() });
  }
  return devices;
}

async function scanMacBlueutil(bin: string): Promise<{ devices: BluetoothDevice[]; available: boolean; note: string }> {
  if (!isCommandAvailable(bin)) return { devices: [], available: false, note: "blueutil not installed (optional third-party CLI, e.g. `brew install blueutil`), skipping live nearby-device inquiry." };
  const result = await run(bin, ["--inquiry", "5"], SCAN_TIMEOUT_MS + 5_000);
  if (result.code !== 0) return { devices: [], available: true, note: `blueutil --inquiry exited with an error: ${result.stderr.trim() || result.code}` };
  const devices = parseBlueutilInquiry(result.stdout);
  return { devices, available: true, note: `blueutil --inquiry: ${devices.length} nearby device(s) discovered.` };
}

// --- Linux: bluetoothctl -------------------------------------------------

/** `bluetoothctl devices` prints one already-known (previously discovered or paired) device per line: "Device XX:XX:XX:XX:XX:XX Name". */
function parseBluetoothctlDevices(stdout: string): BluetoothDevice[] {
  const devices: BluetoothDevice[] = [];
  for (const line of stdout.split("\n")) {
    const m = /^Device\s+([0-9A-F:]{17})\s+(.*)$/i.exec(line.trim());
    if (!m) continue;
    devices.push({ address: m[1], name: m[2], raw: line.trim() });
  }
  return devices;
}

async function scanLinuxBluetoothctl(bin: string, scanWindowMs: number): Promise<{ devices: BluetoothDevice[]; available: boolean; note: string }> {
  if (!isCommandAvailable(bin)) return { devices: [], available: false, note: "bluetoothctl not found (install bluez)." };
  // `bluetoothctl scan on` runs interactively/indefinitely, so a short live
  // discovery window is done by starting a scan, waiting, then reading back
  // the accumulated device list — rather than trying to parse scan's
  // continuous event stream, which the non-interactive `devices` subcommand
  // already reports after this same session has been scanning.
  const scanChild = spawn(bin, ["scan", "on"]);
  await new Promise((resolve) => setTimeout(resolve, scanWindowMs));
  scanChild.kill("SIGTERM");

  const result = await run(bin, ["devices"]);
  if (result.code !== 0) return { devices: [], available: true, note: `bluetoothctl devices exited with an error: ${result.stderr.trim() || result.code}` };
  const devices = parseBluetoothctlDevices(result.stdout);
  return { devices, available: true, note: `bluetoothctl: ${devices.length} device(s) known (paired and/or discovered during a ${scanWindowMs / 1000}s scan window).` };
}

// --- Linux: BLE GATT discovery (read-only), ported from wireless-lab's ---
// bluetooth/gatt package. Drives bluetoothctl's interactive "menu gatt"
// flow to enumerate services/characteristics/descriptors and, optionally,
// read specific characteristic values. Never writes to a characteristic —
// see security_bluetooth_gatt_active_write's still-unimplemented stub for
// that materially different (state-changing) operation. macOS has no
// standard-tooling CLI equivalent to bluetoothctl's GATT menu, so this is
// Linux-only, same restriction wireless-lab's own module documented.
export interface GattDiscoveryResult {
  deviceAddress: string;
  attributes: GattAttribute[];
  values: Record<string, string>; // characteristic path -> hex string
}

async function discoverGatt(bluetoothctlBin: string, deviceAddress: string, readCharacteristicPaths: string[]): Promise<GattDiscoveryResult & { note: string }> {
  const session = new BluetoothctlSession(bluetoothctlBin);
  try {
    session.start();
    await session.send("", 100); // let the banner/agent-registration print settle
    await session.send("menu gatt");
    const listOutput = await session.send(`list-attributes ${deviceAddress}`, 300);
    const attributes = parseListAttributes(listOutput);

    const values: Record<string, string> = {};
    for (const path of readCharacteristicPaths) {
      await session.send(`select-attribute ${path}`);
      const readOutput = await session.send("read", 250);
      const value = parseReadValue(readOutput);
      if (value) values[path] = value.toString("hex");
    }

    return { deviceAddress, attributes, values, note: `bluetoothctl GATT discovery: ${attributes.length} attribute(s) found for ${deviceAddress}${readCharacteristicPaths.length > 0 ? `, ${Object.keys(values).length}/${readCharacteristicPaths.length} characteristic(s) read` : ""}.` };
  } finally {
    session.close();
  }
}

function findingsFromGattAudit(discovery: GattDiscoveryResult): ScanOutput {
  const findings: Finding[] = [];
  const passedControls: PassedControl[] = [];
  const auditFindings = auditGattAttributes(discovery.attributes);
  for (const f of auditFindings) {
    findings.push({
      id: `bt-gatt-legacy-${f.uuid}`,
      title: f.title,
      severity: severityFromScore(5.5),
      cvssScore: 5.5,
      description: f.description,
      remediation: "Confirm this service requires authentication/pairing before accepting commands, or disable it if unused.",
      affectedEndpoint: discovery.deviceAddress,
    });
  }
  if (auditFindings.length === 0) {
    passedControls.push({ label: "GATT service audit", detail: "No known legacy/high-risk service UUIDs observed among discovered attributes." });
  }
  for (const [path, hex] of Object.entries(discovery.values)) {
    passedControls.push({ label: `Characteristic ${path}`, detail: `Read ${hex.length / 2} byte(s): ${hex}` });
  }
  return { findings, passedControls };
}

// --- reporting -------------------------------------------------------

/** No per-device security "finding" is fabricated here — see the tool description for why. Devices are reported as informational passed-controls (what's discoverable), not judged. */
function reportFromDevices(devices: BluetoothDevice[]): ScanOutput {
  const passedControls: PassedControl[] = devices.map((d) => ({
    label: d.name || "(unnamed device)",
    detail: `${d.address ?? "address unknown"}${d.rssi ? `, ${d.rssi}` : ""}${d.paired !== undefined ? `, ${d.paired ? "paired" : "not paired"}` : ""}${d.connected !== undefined ? `, ${d.connected ? "connected" : "not connected"}` : ""}`,
  }));
  return { findings: [], passedControls };
}

// --- tool ------------------------------------------------------------

export interface SecurityScanBluetoothOptions {
  systemProfilerBinary?: string;
  blueutilBinary?: string;
  bluetoothctlBinary?: string;
  /** Test-only: override process.platform's value. */
  platformOverride?: NodeJS.Platform;
  /** Test-only: shrink bluetoothctl's live-scan window below its 8s default. */
  scanWindowMs?: number;
}

export interface SecurityScanBluetoothInput {
  /** Optional: a known device address (from a prior scan) to run read-only
   * BLE GATT discovery against instead of discovery/enumeration. Linux only
   * (bluetoothctl's GATT menu has no macOS standard-tooling equivalent). */
  deviceAddress?: string;
  /** With deviceAddress: characteristic paths (as reported by discovery) to
   * also read a value from. Read-only — this never writes to a
   * characteristic (see security_bluetooth_gatt_active_write). */
  readCharacteristicPaths?: string[];
}

export function createSecurityScanBluetoothTool(options: SecurityScanBluetoothOptions = {}): ToolDefinition<SecurityScanBluetoothInput> {
  const platform = options.platformOverride ?? process.platform;
  const systemProfilerBin = options.systemProfilerBinary ?? "system_profiler";
  const blueutilBin = options.blueutilBinary ?? "blueutil";
  const bluetoothctlBin = options.bluetoothctlBinary ?? "bluetoothctl";
  const scanWindowMs = options.scanWindowMs ?? SCAN_TIMEOUT_MS;

  return {
    name: "security_scan_bluetooth",
    description:
      "Bluetooth device discovery: lists paired/known devices and, where a live-scan tool is installed, nearby " +
      "discoverable devices, name, address, and signal strength where available. macOS: " +
      "`system_profiler SPBluetoothDataType` for paired/connected devices, plus `blueutil --inquiry` (optional " +
      "third-party CLI, only used if already installed) for a live nearby-device scan. Linux: `bluetoothctl " +
      "devices` (paired and previously-discovered devices), running a short `bluetoothctl scan on` window first " +
      "if bluetoothctl is available. " +
      "SURFACE-LEVEL ONLY: this reports what's discoverable (name/address/RSSI), not each device's actual " +
      "pairing security, determining whether a device uses a weak/deprecated pairing method (e.g. Just Works) " +
      "requires sniffing the pairing exchange itself, which this tool does not attempt. " +
      "Alternatively, pass `deviceAddress` (Linux only) to run read-only BLE GATT discovery against that " +
      "device instead, drives bluetoothctl's interactive GATT menu to enumerate services/characteristics/" +
      "descriptors, and optionally reads back specific characteristics via `readCharacteristicPaths`. Flags " +
      "known legacy/high-risk GATT service UUIDs (e.g. unauthenticated vendor UART bridges) as findings. Never " +
      "writes to a characteristic, see security_bluetooth_gatt_active_write for that (unimplemented) " +
      "operation. " +
      "OUT OF SCOPE, not implemented here: BLE GATT-level exploitation/writes, and anything requiring a " +
      "specialized Bluetooth adapter or firmware-level access.",
    // Passive discovery/enumeration only, same tier as security_scan_wifi
    // and list_usb_devices — no connection is made to any discovered
    // device, just listening for/reading back what's already advertising
    // or already paired. GATT discovery does open a connection to read
    // already-exposed characteristic values, but stays read-only — same
    // tier as reading a file the target already serves up.
    riskLevel: "safe",
    inputSchema: {
      type: "object",
      properties: {
        deviceAddress: { type: "string", description: "Device address to run read-only BLE GATT discovery against instead of discovery/enumeration (Linux only)" },
        readCharacteristicPaths: { type: "array", items: { type: "string" }, description: "With deviceAddress: characteristic paths (from a prior discovery) to read a value from" },
      },
    },
    describeCall: (input) => (input.deviceAddress ? `GATT discovery for Bluetooth device ${input.deviceAddress}` : "scan for nearby/paired Bluetooth devices"),
    async handler(input) {
      if (input.deviceAddress) {
        if (platform !== "linux") {
          return { content: `Read-only GATT discovery via bluetoothctl targets Linux only (no standard macOS CLI equivalent); this host reports platform "${platform}".`, isError: true };
        }
        if (!isCommandAvailable(bluetoothctlBin)) {
          return { content: "bluetoothctl not found (install bluez).", isError: true };
        }
        // Real command-injection gap, same class as the one already fixed
        // in security_bluetooth_gatt_active_write (see bluetooth-gatt.ts's
        // isValidMacAddress/isValidGattPath doc comments): deviceAddress and
        // each readCharacteristicPaths entry get spliced directly into
        // lines written to bluetoothctl's interactive stdin REPL
        // (`list-attributes <address>` / `select-attribute <path>` inside
        // discoverGatt) — and unlike the active-write tool, this one is
        // riskLevel "safe", so it runs with NO permission prompt at all. A
        // newline embedded in either field would inject a second,
        // unauthorized bluetoothctl command with zero user confirmation.
        if (!isValidMacAddress(input.deviceAddress)) {
          return { content: `"${input.deviceAddress}" is not a valid device address, expected a MAC address like "AA:BB:CC:DD:EE:FF".`, isError: true };
        }
        const invalidPath = (input.readCharacteristicPaths ?? []).find((p) => !isValidGattPath(p));
        if (invalidPath !== undefined) {
          return { content: `"${invalidPath}" is not a valid GATT characteristic path, expected a bluez object path like "/org/bluez/hci0/dev_.../char.....".`, isError: true };
        }
        const discovery = await discoverGatt(bluetoothctlBin, input.deviceAddress, input.readCharacteristicPaths ?? []);
        if (discovery.attributes.length === 0) {
          return { content: `No GATT attributes discovered for ${input.deviceAddress}.\n\n${discovery.note}`, isError: false, metadata: { discovery } };
        }
        const output = findingsFromGattAudit(discovery);
        const body = formatScanOutput(`GATT attributes for ${input.deviceAddress}`, output);
        return { content: `${body}\n\n${discovery.note}`, isError: false, metadata: { discovery } };
      }

      const notes: string[] = [];
      let devices: BluetoothDevice[] = [];

      if (platform === "darwin") {
        const sp = await scanMacSystemProfiler(systemProfilerBin);
        notes.push(sp.available ? sp.note : `Paired-device enumeration skipped: ${sp.note}`);
        devices = sp.devices;
        const blueutil = await scanMacBlueutil(blueutilBin);
        notes.push(blueutil.available ? blueutil.note : blueutil.note);
        for (const d of blueutil.devices) {
          if (!devices.some((existing) => existing.address === d.address)) devices.push(d);
        }
      } else if (platform === "linux") {
        const bt = await scanLinuxBluetoothctl(bluetoothctlBin, scanWindowMs);
        notes.push(bt.available ? bt.note : `Bluetooth enumeration skipped: ${bt.note}`);
        devices = bt.devices;
      } else {
        notes.push(`No Bluetooth enumeration implemented for platform "${platform}" (this tool targets macOS/Linux; Windows has no standard-tooling equivalent used here).`);
      }

      if (devices.length === 0) {
        return { content: `No Bluetooth devices found or enumerable.\n\n--- detection methods ---\n${notes.join("\n")}`, isError: false, metadata: { devices: [] } };
      }

      const output = reportFromDevices(devices);
      const body = formatScanOutput("Bluetooth devices", output);
      return { content: `${body}\n\n--- detection methods ---\n${notes.join("\n")}`, isError: false, metadata: { devices } };
    },
  };
}
