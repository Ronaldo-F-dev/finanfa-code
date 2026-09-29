import { spawn } from "node:child_process";
import type { ToolDefinition } from "../../core/types.js";
import { isCommandAvailable } from "../../util/command-availability.js";

// Real gap this fills: the IoT tool category (gpio/mqtt/coap/serial) talks
// to microcontrollers over USB/serial/GPIO, but nothing here detects a
// phone plugged into the host over USB or lets the agent run commands
// against one — a real, everyday case (debugging a mobile app, sideloading
// an APK, pulling logs) distinct from the microcontroller-flashing tools
// in firmware-flash.ts.
//
// Every external CLI this wraps (system_profiler, lsusb, adb, idevice_id/
// ideviceinfo, PowerShell) is optional and checked via isCommandAvailable
// before being shelled out to — list_usb_devices degrades gracefully
// (reporting which detection methods ran vs were skipped) rather than
// failing outright when one is missing, since a machine plausibly has
// none, some, or all of them installed.

const DETECT_TIMEOUT_MS = 20_000;
const ADB_DEFAULT_TIMEOUT_MS = 30_000;

export interface UsbDevice {
  name: string;
  vendor?: string;
  type: "phone (Android)" | "phone (iOS)" | "other USB device";
  /** adb serial (Android) or UDID (iOS) — what run_adb_command targets. Unset for devices only seen generically. */
  id?: string;
  /** Raw vendor:product id or adb status, kept for debugging/disambiguation, not meant to be parsed. */
  raw?: string;
}

interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
  error?: NodeJS.ErrnoException;
}

/** Plain argv spawn (never a shell) with a timeout — same shape as git.ts's runGit, just returning raw stdout/stderr instead of a formatted ToolResult since callers here need to parse it (JSON, tabular adb/lsusb output). */
function run(bin: string, args: string[], timeoutMs = DETECT_TIMEOUT_MS): Promise<RunResult> {
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

function guessDeviceType(...parts: (string | undefined)[]): UsbDevice["type"] {
  const s = parts.filter(Boolean).join(" ").toLowerCase();
  if (/iphone|ipad|ipod/.test(s)) return "phone (iOS)";
  if (/android|samsung|galaxy|pixel|xiaomi|redmi|oneplus|huawei|honor|oppo|vivo|motorola|\bmoto\b|nokia|htc|zenfone|xperia/.test(s)) return "phone (Android)";
  return "other USB device";
}

// --- macOS: system_profiler SPUSBDataType -json -----------------------

interface SpUsbItem {
  _name?: string;
  manufacturer?: string;
  vendor_id?: string;
  product_id?: string;
  serial_num?: string;
  _items?: SpUsbItem[];
}

function flattenSpUsb(items: SpUsbItem[] | undefined, out: UsbDevice[]): void {
  if (!items) return;
  for (const item of items) {
    // A hub entry recurses without itself being reported; a real device
    // entry reports vendor_id or a manufacturer string (a bare bus/hub
    // node has neither).
    if (item.vendor_id || item.manufacturer) {
      out.push({
        name: item._name ?? "Unknown USB device",
        vendor: item.manufacturer,
        type: guessDeviceType(item._name, item.manufacturer),
        raw: item.vendor_id ? `${item.vendor_id}${item.product_id ? ` / ${item.product_id}` : ""}` : undefined,
      });
    }
    flattenSpUsb(item._items, out);
  }
}

async function listMacUsb(bin: string): Promise<{ devices: UsbDevice[]; available: boolean; note: string }> {
  if (!isCommandAvailable(bin)) return { devices: [], available: false, note: "system_profiler not found (unexpected on macOS)." };
  const result = await run(bin, ["SPUSBDataType", "-json"]);
  if (result.code !== 0) return { devices: [], available: true, note: `system_profiler exited with an error: ${result.stderr.trim() || result.code}` };
  try {
    const parsed = JSON.parse(result.stdout) as { SPUSBDataType?: SpUsbItem[] };
    const devices: UsbDevice[] = [];
    flattenSpUsb(parsed.SPUSBDataType, devices);
    return { devices, available: true, note: `system_profiler: ${devices.length} USB device(s) enumerated.` };
  } catch (err) {
    return { devices: [], available: true, note: `Failed to parse system_profiler output: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// --- Linux: lsusb -------------------------------------------------------

function parseLsusb(stdout: string): UsbDevice[] {
  const devices: UsbDevice[] = [];
  for (const line of stdout.split("\n")) {
    const m = line.match(/^Bus \d+ Device \d+: ID ([0-9a-f]{4}):([0-9a-f]{4})\s*(.*)$/i);
    if (!m) continue;
    const [, vid, pid, desc] = m;
    devices.push({ name: desc?.trim() || `USB device ${vid}:${pid}`, type: guessDeviceType(desc), raw: `${vid}:${pid}` });
  }
  return devices;
}

async function listLinuxUsb(bin: string): Promise<{ devices: UsbDevice[]; available: boolean; note: string }> {
  if (!isCommandAvailable(bin)) return { devices: [], available: false, note: "lsusb not found — install usbutils (e.g. `apt install usbutils`) for generic USB enumeration." };
  const result = await run(bin, []);
  if (result.code !== 0) return { devices: [], available: true, note: `lsusb exited with an error: ${result.stderr.trim() || result.code}` };
  const devices = parseLsusb(result.stdout);
  return { devices, available: true, note: `lsusb: ${devices.length} USB device(s) enumerated.` };
}

// --- Windows: best-effort, unverified ----------------------------------
// This codebase's actual deployment targets are macOS/Linux; Windows
// support elsewhere is unbuilt/untested. Implemented for completeness
// since PowerShell's Get-PnpDevice is straightforward, but this path has
// not been run against a real Windows machine — treat it as best-effort.

async function listWindowsUsb(bin: string): Promise<{ devices: UsbDevice[]; available: boolean; note: string }> {
  if (!isCommandAvailable(bin)) return { devices: [], available: false, note: "PowerShell not found — skipped Windows USB enumeration." };
  const result = await run(
    bin,
    ["-NoProfile", "-Command", "Get-PnpDevice -PresentOnly | Where-Object { $_.InstanceId -like 'USB*' } | Select-Object FriendlyName,InstanceId | ConvertTo-Json"],
  );
  if (result.code !== 0) return { devices: [], available: true, note: `Get-PnpDevice exited with an error: ${result.stderr.trim() || result.code}` };
  try {
    const raw: unknown = JSON.parse(result.stdout || "[]");
    const list = Array.isArray(raw) ? raw : [raw];
    const devices: UsbDevice[] = list.map((d) => {
      const entry = d as { FriendlyName?: string; InstanceId?: string };
      return { name: entry.FriendlyName ?? entry.InstanceId ?? "Unknown USB device", type: guessDeviceType(entry.FriendlyName), raw: entry.InstanceId };
    });
    return { devices, available: true, note: `Get-PnpDevice: ${devices.length} USB device(s) enumerated (best-effort, unverified on real Windows hardware).` };
  } catch (err) {
    return { devices: [], available: true, note: `Failed to parse Get-PnpDevice output: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// --- Android: adb devices -l --------------------------------------------

async function listAndroidDevices(bin: string): Promise<{ devices: UsbDevice[]; available: boolean; note: string }> {
  if (!isCommandAvailable(bin)) return { devices: [], available: false, note: "adb not available — not found on PATH. Install Android Platform Tools to detect Android devices." };
  const result = await run(bin, ["devices", "-l"]);
  if (result.code !== 0) return { devices: [], available: true, note: `adb devices exited with an error: ${result.stderr.trim() || result.code}` };
  const devices: UsbDevice[] = [];
  // First line is the header "List of devices attached".
  for (const line of result.stdout.split("\n").slice(1)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [serial, status, ...rest] = trimmed.split(/\s+/);
    if (!serial || !status) continue;
    const model = rest.join(" ").match(/model:(\S+)/)?.[1]?.replace(/_/g, " ");
    devices.push({
      name: model ?? `Android device (${status})`,
      type: "phone (Android)",
      id: serial,
      raw: status !== "device" ? `status=${status}` : undefined,
    });
  }
  return { devices, available: true, note: `adb: ${devices.length} Android device(s) found.` };
}

// --- iOS: idevice_id -l / ideviceinfo (libimobiledevice) ----------------

async function listIosDevices(ideviceIdBin: string, ideviceinfoBin: string): Promise<{ devices: UsbDevice[]; available: boolean; note: string }> {
  if (!isCommandAvailable(ideviceIdBin)) return { devices: [], available: false, note: "idevice_id not available — install libimobiledevice (e.g. `brew install libimobiledevice`) to detect iOS devices by UDID." };
  const result = await run(ideviceIdBin, ["-l"]);
  if (result.code !== 0) return { devices: [], available: true, note: `idevice_id exited with an error: ${result.stderr.trim() || result.code}` };
  const udids = result.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  const ideviceinfoAvailable = isCommandAvailable(ideviceinfoBin);
  const devices: UsbDevice[] = [];
  for (const udid of udids) {
    let name = `iOS device (${udid})`;
    if (ideviceinfoAvailable) {
      const info = await run(ideviceinfoBin, ["-u", udid, "-k", "DeviceName"]);
      if (info.code === 0 && info.stdout.trim()) name = info.stdout.trim();
    }
    devices.push({ name, type: "phone (iOS)", id: udid });
  }
  return { devices, available: true, note: `idevice_id: ${devices.length} iOS device(s) found${ideviceinfoAvailable ? "" : " (ideviceinfo not available — names are generic)"}.` };
}

/** Folds phones positively identified by adb/idevice_id into the generic (system_profiler/lsusb) list — attaching the serial/UDID to a matching not-yet-identified entry of the same guessed type where one exists, otherwise appending a new entry. Best-effort: there's no shared USB identifier between "system_profiler says an iPhone is here" and "idevice_id says UDID X is here" to match on precisely. */
function mergeIdentified(generic: UsbDevice[], identified: UsbDevice[]): void {
  for (const dev of identified) {
    const match = generic.find((g) => g.type === dev.type && !g.id);
    if (match) {
      match.id = dev.id;
      if (dev.name) match.name = dev.name;
    } else {
      generic.push(dev);
    }
  }
}

export interface ListUsbDevicesOptions {
  systemProfilerBinary?: string;
  lsusbBinary?: string;
  powershellBinary?: string;
  adbBinary?: string;
  ideviceIdBinary?: string;
  ideviceinfoBinary?: string;
  /** Test-only: override process.platform's value. */
  platformOverride?: NodeJS.Platform;
}

export function createListUsbDevicesTool(options: ListUsbDevicesOptions = {}): ToolDefinition<Record<string, never>> {
  const platform = options.platformOverride ?? process.platform;
  const systemProfilerBin = options.systemProfilerBinary ?? "system_profiler";
  const lsusbBin = options.lsusbBinary ?? "lsusb";
  const powershellBin = options.powershellBinary ?? "powershell";
  const adbBin = options.adbBinary ?? "adb";
  const ideviceIdBin = options.ideviceIdBinary ?? "idevice_id";
  const ideviceinfoBin = options.ideviceinfoBinary ?? "ideviceinfo";

  return {
    name: "list_usb_devices",
    description:
      "List USB devices connected to this machine, surfacing phones (Android/iOS) where identifiable. On " +
      "macOS, enumerates via `system_profiler SPUSBDataType` and separately checks for `idevice_id`/" +
      "`ideviceinfo` (libimobiledevice) to positively identify iOS devices by UDID. On Linux, uses `lsusb`. " +
      "On both, also checks for `adb` (Android Platform Tools) to positively identify Android devices by " +
      "serial. Windows support is best-effort (PowerShell Get-PnpDevice) and unverified on real hardware. " +
      "None of these external tools need to be installed — the result reports which detection methods " +
      "actually ran vs were skipped (not installed) rather than failing outright. An identified phone's id " +
      "(an adb serial or iOS UDID) is what run_adb_command targets — note that only Android devices can " +
      "have commands run against them (see run_adb_command's description for why).",
    riskLevel: "safe",
    inputSchema: { type: "object", properties: {} },
    describeCall: () => "list connected USB devices",
    async handler() {
      const notes: string[] = [];
      let devices: UsbDevice[] = [];

      if (platform === "darwin") {
        const mac = await listMacUsb(systemProfilerBin);
        devices = mac.devices;
        notes.push(mac.available ? mac.note : `Generic USB enumeration skipped: ${mac.note}`);
        const ios = await listIosDevices(ideviceIdBin, ideviceinfoBin);
        notes.push(ios.available ? ios.note : `iOS detection skipped: ${ios.note}`);
        mergeIdentified(devices, ios.devices);
      } else if (platform === "linux") {
        const linux = await listLinuxUsb(lsusbBin);
        devices = linux.devices;
        notes.push(linux.available ? linux.note : `Generic USB enumeration skipped: ${linux.note}`);
      } else if (platform === "win32") {
        const win = await listWindowsUsb(powershellBin);
        devices = win.devices;
        notes.push(win.available ? win.note : `Generic USB enumeration skipped: ${win.note}`);
      } else {
        notes.push(`No generic USB enumeration implemented for platform "${platform}".`);
      }

      const android = await listAndroidDevices(adbBin);
      notes.push(android.available ? android.note : `Android detection skipped: ${android.note}`);
      mergeIdentified(devices, android.devices);

      const lines =
        devices.length > 0
          ? devices.map((d) => `${d.type}: ${d.name}${d.vendor ? ` — ${d.vendor}` : ""}${d.id ? ` (id=${d.id})` : ""}${d.raw ? ` [${d.raw}]` : ""}`)
          : ["No USB devices found."];

      return {
        content: `${lines.join("\n")}\n\n--- detection methods ---\n${notes.join("\n")}`,
        isError: false,
        metadata: { devices },
      };
    },
  };
}

export interface RunAdbCommandOptions {
  adbBinary?: string;
}

export function createRunAdbCommandTool(options: RunAdbCommandOptions = {}): ToolDefinition<{ serial: string; args: string[]; timeout_ms?: number }> {
  const adbBin = options.adbBinary ?? "adb";

  return {
    name: "run_adb_command",
    description:
      "Run a real `adb` command against a specific connected Android device, targeted by serial (see " +
      "list_usb_devices for available serials). Pass the adb subcommand and its arguments as a plain array, " +
      "e.g. ['shell', 'pm', 'list', 'packages'], ['install', 'app.apk'], ['push', 'local.txt', '/sdcard/'], " +
      "['pull', '/sdcard/file.txt', 'local.txt']. " +
      "IMPORTANT: this runs a real command against real physical hardware over USB — install/push/pull/shell " +
      "can modify the device's real filesystem or installed apps, so confirm with the user before running " +
      "anything destructive. Android only: there is deliberately no iOS equivalent of this tool — iOS does " +
      "not allow arbitrary shell command execution over USB without jailbreaking, so list_usb_devices can " +
      "identify a connected iOS device by UDID but nothing in this codebase can run commands on one.",
    riskLevel: "dangerous",
    inputSchema: {
      type: "object",
      properties: {
        serial: { type: "string", description: "Device serial from list_usb_devices' output" },
        args: { type: "array", items: { type: "string" }, description: "adb subcommand + args, as a plain array, e.g. ['shell', 'ls', '/sdcard']" },
        timeout_ms: { type: "number", description: `Timeout in milliseconds (default ${ADB_DEFAULT_TIMEOUT_MS})` },
      },
      required: ["serial", "args"],
    },
    riskKey: (input) => `run_adb_command:${input.args[0] ?? ""}`,
    describeCall: (input) => `adb -s ${input.serial} ${input.args.join(" ")}`,
    async handler(input) {
      if (!isCommandAvailable(adbBin)) {
        return {
          content: "adb not found — install Android Platform Tools (https://developer.android.com/tools/releases/platform-tools) and ensure `adb` is on PATH.",
          isError: true,
        };
      }
      const result = await run(adbBin, ["-s", input.serial, ...input.args], input.timeout_ms ?? ADB_DEFAULT_TIMEOUT_MS);
      if (result.error) {
        return { content: `Failed to run adb: ${result.error.message}`, isError: true };
      }
      const content = result.stdout.trim() || result.stderr.trim() || "(no output)";
      return { content, isError: result.code !== 0 };
    },
  };
}
