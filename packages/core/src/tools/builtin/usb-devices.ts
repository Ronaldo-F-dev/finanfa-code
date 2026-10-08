import { spawn } from "node:child_process";
import net from "node:net";
import type { ToolDefinition } from "../../core/types.js";
import { isCommandAvailable } from "../../util/command-availability.js";
import { killProcessGroupAndWait } from "../../util/process.js";
import { waitForPort } from "./wait-for-port.js";
import { buildSshArgs, runSshWithRetry } from "./remote-exec.js";

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
  if (!isCommandAvailable(bin)) return { devices: [], available: false, note: "lsusb not found, install usbutils (e.g. `apt install usbutils`) for generic USB enumeration." };
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
  if (!isCommandAvailable(bin)) return { devices: [], available: false, note: "PowerShell not found, skipped Windows USB enumeration." };
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
  if (!isCommandAvailable(bin)) return { devices: [], available: false, note: "adb not available, not found on PATH. Install Android Platform Tools to detect Android devices." };
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
  if (!isCommandAvailable(ideviceIdBin)) return { devices: [], available: false, note: "idevice_id not available, install libimobiledevice (e.g. `brew install libimobiledevice`) to detect iOS devices by UDID." };
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
  return { devices, available: true, note: `idevice_id: ${devices.length} iOS device(s) found${ideviceinfoAvailable ? "" : " (ideviceinfo not available, names are generic)"}.` };
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
      "None of these external tools need to be installed, the result reports which detection methods " +
      "actually ran vs were skipped (not installed) rather than failing outright. An identified phone's id " +
      "(an adb serial or iOS UDID) is what run_adb_command/run_ios_ssh_command target, note that iOS command " +
      "execution only works on a JAILBROKEN device running an SSH server (see run_ios_ssh_command).",
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
          ? devices.map((d) => `${d.type}: ${d.name}${d.vendor ? `, ${d.vendor}` : ""}${d.id ? ` (id=${d.id})` : ""}${d.raw ? ` [${d.raw}]` : ""}`)
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
      "IMPORTANT: this runs a real command against real physical hardware over USB, install/push/pull/shell " +
      "can modify the device's real filesystem or installed apps, so confirm with the user before running " +
      "anything destructive. Android only: stock iOS does not allow arbitrary shell command execution over " +
      "USB without jailbreaking, for a JAILBROKEN iOS device with an SSH server installed, see " +
      "run_ios_ssh_command instead.",
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
          content: "adb not found, install Android Platform Tools (https://developer.android.com/tools/releases/platform-tools) and ensure `adb` is on PATH.",
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

// --- iOS: run_ios_ssh_command (jailbroken devices only) -----------------
//
// Stock iOS has no adb equivalent (see run_adb_command's description), but
// a JAILBROKEN device can run a real SSH server (OpenSSH via Cydia/Sileo)
// reachable over USB by tunneling a local TCP port to the device's SSH
// port via `iproxy` (part of libimobiledevice — already a dependency of
// list_usb_devices' iOS detection above, via idevice_id/ideviceinfo).
//
// This deliberately reuses remote-exec.ts's SSH execution path
// (buildSshArgs/runSshWithRetry — the real, already-installed `ssh`
// binary run with BatchMode=yes) rather than adding a new SSH client
// dependency: there is no ssh2 (or similar) library anywhere in this
// monorepo, and remote-exec.ts's "shell out to the user's real ssh,
// non-interactively" IS this codebase's one real SSH execution path.
// Called directly with an ephemeral SshTarget pointed at
// localhost:<localPort> rather than going through register_remote_host's
// persistent named-host registry — that registry exists for hosts worth
// remembering across calls (list_remote_hosts, health history), which a
// one-off tunnel through a specific USB-connected device's UDID is not;
// forcing a register/exec/remove round trip here would just be registry
// churn for a target that's only ever valid while this one call runs.
//
// Same credential convention as run_remote_command/register_remote_host:
// no password field. BatchMode=yes (baked into buildSshArgs) means
// password auth fails closed rather than prompting — auth is by SSH key
// (ssh-agent, or an explicit identity_file), never a password passed as a
// tool argument. A freshly jailbroken device's SSH server commonly still
// has the well-known default root password ("alpine") — the user should
// disable password auth or change it, not rely on this tool to keep it
// safe.

const IPROXY_BIND_TIMEOUT_MS = 15_000;
const IOS_SSH_DEFAULT_TIMEOUT_MS = 60_000;

/** Binds an ephemeral local port just to learn which one the OS handed out, then frees it — same "ask the OS" trick as a lot of test-server setups, and the standard way to auto-pick a free TCP port from Node without a helper library. */
function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : undefined;
      server.close(() => (port ? resolve(port) : reject(new Error("Failed to allocate a free local port."))));
    });
  });
}

export interface RunIosSshCommandOptions {
  iproxyBinary?: string;
  sshBinary?: string;
}

interface RunIosSshCommandInput {
  udid: string;
  command: string;
  user?: string;
  device_port?: number;
  local_port?: number;
  identity_file?: string;
  timeout_ms?: number;
}

export function createRunIosSshCommandTool(options: RunIosSshCommandOptions = {}): ToolDefinition<RunIosSshCommandInput> {
  const iproxyBin = options.iproxyBinary ?? "iproxy";
  const sshBin = options.sshBinary ?? "ssh";

  return {
    name: "run_ios_ssh_command",
    description:
      "Run a real shell command on a connected iOS device over USB, via SSH tunneled through `iproxy` " +
      "(libimobiledevice). ONLY works on a JAILBROKEN device, stock iOS has no SSH server at all, so this " +
      "will fail on any non-jailbroken device even if list_usb_devices detects it by UDID. Requires: (1) " +
      "`iproxy` installed locally (part of libimobiledevice, e.g. `brew install libimobiledevice`), and (2) " +
      "the device's own SSH server (OpenSSH via Cydia/Sileo) actually running, this tool does not install " +
      "or start one. Targets the device by UDID (see list_usb_devices). Auth is key-based only (ssh-agent or " +
      "identity_file), like run_remote_command, this never takes a password as input; a device still using " +
      "the well-known default jailbreak root password ('alpine') should have that changed. " +
      "IMPORTANT: this runs a real command against real physical hardware, typically as root, confirm with " +
      "the user before running anything destructive.",
    riskLevel: "dangerous",
    inputSchema: {
      type: "object",
      properties: {
        udid: { type: "string", description: "Device UDID from list_usb_devices' output" },
        command: { type: "string", description: "Command to run on the device, interpreted by the device's remote shell" },
        user: { type: "string", description: "SSH username (default 'root', jailbroken iOS's SSH default)" },
        device_port: { type: "number", description: "SSH port on the device itself (default 22)" },
        local_port: { type: "number", description: "Local port to tunnel through. Omit to auto-pick a free one." },
        identity_file: { type: "string", description: "Path to a specific private key, if not already resolved via ssh-agent" },
        timeout_ms: { type: "number", description: `Timeout in milliseconds for the SSH command itself (default ${IOS_SSH_DEFAULT_TIMEOUT_MS})` },
      },
      required: ["udid", "command"],
    },
    riskKey: (input) => `run_ios_ssh_command:${input.udid}`,
    describeCall: (input) => `ssh (via iproxy) ${input.user ?? "root"}@<iOS ${input.udid}>: ${input.command}`,
    async handler(input) {
      if (!isCommandAvailable(iproxyBin)) {
        return { content: "iproxy not found, install libimobiledevice (e.g. `brew install libimobiledevice`).", isError: true };
      }

      const devicePort = input.device_port ?? 22;
      let localPort: number;
      try {
        localPort = input.local_port ?? (await pickFreePort());
      } catch (err) {
        return { content: `Failed to pick a local port for the tunnel: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }

      let iproxyStderr = "";
      let iproxyExited = false;
      let spawnErrorMessage: string | undefined;
      const iproxy = spawn(iproxyBin, [String(localPort), String(devicePort), input.udid], { detached: true });
      iproxy.stderr?.on("data", (d) => (iproxyStderr += d));
      iproxy.once("error", (err) => {
        spawnErrorMessage = err.message;
      });
      iproxy.once("exit", () => {
        iproxyExited = true;
      });

      try {
        // Wait for the tunnel to actually bind rather than guessing a fixed
        // sleep — shouldAbort stops the poll early if iproxy dies outright
        // (bad UDID, device unplugged, iproxy itself missing a runtime dep)
        // instead of waiting out the full bind timeout for a tunnel that
        // will never come up.
        const bindResult = await waitForPort("127.0.0.1", localPort, IPROXY_BIND_TIMEOUT_MS, { shouldAbort: () => iproxyExited || spawnErrorMessage !== undefined });
        if (spawnErrorMessage) {
          return { content: `Failed to start iproxy: ${spawnErrorMessage}`, isError: true };
        }
        if (!bindResult.ready) {
          const detail = iproxyStderr.trim() || (iproxyExited ? "iproxy exited before the tunnel came up" : "timed out waiting for the tunnel to bind");
          return { content: `iproxy tunnel to ${input.udid}:${devicePort} never came up: ${detail}`, isError: true };
        }

        const args = buildSshArgs({ host: "127.0.0.1", port: localPort, user: input.user ?? "root", identityFile: input.identity_file, command: input.command });
        const result = await runSshWithRetry(sshBin, args, input.timeout_ms ?? IOS_SSH_DEFAULT_TIMEOUT_MS);
        const header = result.isError ? "(failed)\n" : "(exit code 0)\n";
        return { content: `${header}--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`, isError: result.isError };
      } finally {
        // Tear down the tunnel unconditionally (success or failure) so it
        // never leaks a lingering iproxy process across calls — and wait for
        // it to actually exit before returning: a caller that got control
        // back while iproxy was still dying could otherwise try to reuse the
        // same local port and hit EADDRINUSE (real observed race).
        await killProcessGroupAndWait(iproxy);
      }
    },
  };
}
