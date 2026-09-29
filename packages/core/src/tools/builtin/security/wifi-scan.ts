import { spawn } from "node:child_process";
import type { ToolDefinition } from "../../../core/types.js";
import { isCommandAvailable } from "../../../util/command-availability.js";
import { severityFromScore } from "./cvss.js";
import { formatScanOutput, type Finding, type PassedControl, type ScanOutput } from "./types.js";

// Real gap this fills: no wireless recon at all in this directory. Deliberately
// scoped to what a general-purpose laptop's built-in Wi-Fi chipset can do
// without special drivers/hardware: passive nearby-network enumeration via
// each OS's own standard tooling. Explicitly OUT of scope, and not attempted
// here: monitor mode, packet injection, deauth attacks, WPA handshake
// capture/cracking. Those need a chipset+driver combo (and often a
// dedicated adapter) this session can't assume exists, and deauth/handshake
// capture in particular are attack actions against a network's other
// clients, not passive enumeration of the target's own environment — a
// materially different authorization question than "list what my Wi-Fi
// radio already sees".
const SCAN_TIMEOUT_MS = 20_000;

export type WifiSecurity = "open" | "wep" | "wpa" | "wpa2" | "wpa3" | "unknown";

export interface WifiNetwork {
  ssid: string;
  bssid?: string;
  channel?: string;
  signal?: string;
  security: WifiSecurity;
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

function classifySecurity(raw: string): WifiSecurity {
  const s = raw.trim().toUpperCase();
  if (s === "" || s === "--" || s === "NONE") return "open";
  if (s.includes("WPA3")) return "wpa3";
  if (s.includes("WPA2")) return "wpa2";
  if (s.includes("WPA")) return "wpa"; // WPA1-only, no WPA2/3 alongside it
  if (s.includes("WEP")) return "wep";
  return "unknown";
}

// --- macOS: `airport -s` (if still present) + system_profiler fallback --

const DEFAULT_AIRPORT_BIN = "/System/Library/PrivateFrameworks/Apple80211.framework/Versions/Current/Resources/airport";

/** `airport -s` prints a fixed-width table: SSID BSSID RSSI CHANNEL HT CC SECURITY. SSID can contain spaces, so columns are parsed from the right (BSSID's colon-hex shape anchors the split) rather than a naive whitespace split. */
function parseAirportScan(stdout: string): WifiNetwork[] {
  const lines = stdout.split("\n").slice(1); // header row
  const networks: WifiNetwork[] = [];
  const rowPattern = /^(.*?)\s+((?:[0-9a-f]{2}:){5}[0-9a-f]{2})\s+(-?\d+)\s+(\S+)\s+\S+\s+\S+\s+(.*)$/i;
  for (const line of lines) {
    if (!line.trim()) continue;
    const m = rowPattern.exec(line);
    if (!m) continue;
    const [, ssid, bssid, rssi, channel, security] = m;
    networks.push({ ssid: ssid.trim(), bssid, signal: `${rssi} dBm`, channel, security: classifySecurity(security), raw: line.trim() });
  }
  return networks;
}

async function scanMacAirport(bin: string): Promise<{ networks: WifiNetwork[]; available: boolean; note: string }> {
  if (!isCommandAvailable(bin)) {
    return { networks: [], available: false, note: "airport utility not found (Apple removed it from some macOS versions) — falling back to system_profiler for the currently associated network only." };
  }
  const result = await run(bin, ["-s"]);
  if (result.code !== 0) return { networks: [], available: true, note: `airport -s exited with an error: ${result.stderr.trim() || result.code}` };
  const networks = parseAirportScan(result.stdout);
  return { networks, available: true, note: `airport -s: ${networks.length} nearby network(s) found.` };
}

interface SpAirPortNetwork {
  _name?: string;
  spairport_security_mode?: string;
  spairport_signal_noise?: string;
  spairport_network_channel?: string;
}

interface SpAirPortInterface {
  spairport_current_network_information?: SpAirPortNetwork;
}

/** Fallback used when `airport` is gone: only reports the currently-associated network's own details (SSID/security/channel/RSSI), not a full nearby-network scan — system_profiler doesn't expose that. */
async function scanMacSystemProfiler(bin: string): Promise<{ networks: WifiNetwork[]; available: boolean; note: string }> {
  if (!isCommandAvailable(bin)) return { networks: [], available: false, note: "system_profiler not found (unexpected on macOS)." };
  const result = await run(bin, ["SPAirPortDataType", "-json"]);
  if (result.code !== 0) return { networks: [], available: true, note: `system_profiler exited with an error: ${result.stderr.trim() || result.code}` };
  try {
    const parsed = JSON.parse(result.stdout) as { SPAirPortDataType?: Array<{ spairport_airport_interfaces?: SpAirPortInterface[] }> };
    const networks: WifiNetwork[] = [];
    for (const item of parsed.SPAirPortDataType ?? []) {
      for (const iface of item.spairport_airport_interfaces ?? []) {
        const current = iface.spairport_current_network_information;
        if (!current?._name) continue;
        networks.push({
          ssid: current._name,
          channel: current.spairport_network_channel,
          signal: current.spairport_signal_noise,
          security: classifySecurity(current.spairport_security_mode ?? ""),
          raw: JSON.stringify(current),
        });
      }
    }
    return { networks, available: true, note: `system_profiler: ${networks.length} currently-associated network(s) reported (not a nearby-network scan).` };
  } catch (err) {
    return { networks: [], available: true, note: `Failed to parse system_profiler output: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// --- Linux: nmcli (preferred) or iwlist ---------------------------------

/** `nmcli -t -f ... device wifi list` uses colon-separated terse output; nmcli escapes literal colons within a field as `\:`, which this splits on an unescaped colon to avoid breaking on a BSSID's own colons. */
function splitNmcliTerseLine(line: string): string[] {
  return line.split(/(?<!\\):/).map((f) => f.replace(/\\:/g, ":"));
}

function parseNmcli(stdout: string): WifiNetwork[] {
  const networks: WifiNetwork[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const [ssid, bssid, chan, signal, security] = splitNmcliTerseLine(line);
    if (!ssid) continue;
    networks.push({ ssid, bssid, channel: chan, signal: signal ? `${signal}%` : undefined, security: classifySecurity(security ?? ""), raw: line });
  }
  return networks;
}

async function scanLinuxNmcli(bin: string): Promise<{ networks: WifiNetwork[]; available: boolean; note: string }> {
  if (!isCommandAvailable(bin)) return { networks: [], available: false, note: "nmcli not found." };
  const result = await run(bin, ["-t", "-f", "SSID,BSSID,CHAN,SIGNAL,SECURITY", "device", "wifi", "list"]);
  if (result.code !== 0) return { networks: [], available: true, note: `nmcli exited with an error: ${result.stderr.trim() || result.code}` };
  const networks = parseNmcli(result.stdout);
  return { networks, available: true, note: `nmcli: ${networks.length} nearby network(s) found.` };
}

/** `iwlist scan` output shape: one "Cell NN - Address: ..." block per network, ESSID/Encryption key/IE (WPA/WPA2) as indented sub-lines. */
function parseIwlist(stdout: string): WifiNetwork[] {
  const networks: WifiNetwork[] = [];
  const blocks = stdout.split(/\s+Cell \d+ - /).slice(1);
  for (const block of blocks) {
    const bssid = /Address:\s*(\S+)/.exec(block)?.[1];
    const ssid = /ESSID:"([^"]*)"/.exec(block)?.[1];
    const channel = /Channel:(\d+)/.exec(block)?.[1];
    const signal = /Signal level=(-?\d+ ?d?Bm?)/.exec(block)?.[1];
    const encryptionOn = /Encryption key:on/.test(block);
    let security: WifiSecurity = "open";
    if (encryptionOn) {
      if (/IE:.*WPA3/.test(block)) security = "wpa3";
      else if (/IE:.*WPA2/.test(block)) security = "wpa2";
      else if (/IE:.*WPA/.test(block)) security = "wpa";
      else security = "wep";
    }
    if (ssid !== undefined) networks.push({ ssid, bssid, channel, signal, security, raw: block.trim() });
  }
  return networks;
}

async function scanLinuxIwlist(bin: string): Promise<{ networks: WifiNetwork[]; available: boolean; note: string }> {
  if (!isCommandAvailable(bin)) return { networks: [], available: false, note: "iwlist not found (install wireless-tools)." };
  const result = await run(bin, ["scan"]);
  if (result.code !== 0) return { networks: [], available: true, note: `iwlist scan exited with an error (often needs root): ${result.stderr.trim() || result.code}` };
  const networks = parseIwlist(result.stdout);
  return { networks, available: true, note: `iwlist scan: ${networks.length} nearby network(s) found.` };
}

// --- Windows: best-effort, unverified -----------------------------------
// Same caveat as usb-devices.ts's Windows path: this codebase's actual
// deployment targets are macOS/Linux, so this has not been run against
// real Windows hardware.

function parseNetshWlan(stdout: string): WifiNetwork[] {
  const networks: WifiNetwork[] = [];
  let current: Partial<WifiNetwork> & { ssid?: string } = {};
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    const ssidMatch = /^SSID\s+\d+\s*:\s*(.*)$/.exec(line);
    if (ssidMatch) {
      if (current.ssid) networks.push({ ssid: current.ssid, bssid: current.bssid, channel: current.channel, signal: current.signal, security: current.security ?? "unknown", raw: current.raw ?? "" });
      current = { ssid: ssidMatch[1], security: "unknown", raw: line };
      continue;
    }
    const bssidMatch = /^BSSID\s+\d+\s*:\s*(\S+)/.exec(line);
    if (bssidMatch) current.bssid = bssidMatch[1];
    const authMatch = /^Authentication\s*:\s*(.*)$/.exec(line);
    if (authMatch) current.security = classifySecurity(authMatch[1]);
    const channelMatch = /^Channel\s*:\s*(\d+)/.exec(line);
    if (channelMatch) current.channel = channelMatch[1];
    const signalMatch = /^Signal\s*:\s*(\d+%)/.exec(line);
    if (signalMatch) current.signal = signalMatch[1];
  }
  if (current.ssid) networks.push({ ssid: current.ssid, bssid: current.bssid, channel: current.channel, signal: current.signal, security: current.security ?? "unknown", raw: current.raw ?? "" });
  return networks;
}

async function scanWindowsNetsh(bin: string): Promise<{ networks: WifiNetwork[]; available: boolean; note: string }> {
  if (!isCommandAvailable(bin)) return { networks: [], available: false, note: "netsh not found (unexpected on Windows)." };
  const result = await run(bin, ["wlan", "show", "networks", "mode=bssid"]);
  if (result.code !== 0) return { networks: [], available: true, note: `netsh wlan show networks exited with an error: ${result.stderr.trim() || result.code}` };
  const networks = parseNetshWlan(result.stdout);
  return { networks, available: true, note: `netsh wlan show networks: ${networks.length} nearby network(s) found (best-effort, unverified on real Windows hardware).` };
}

// --- findings ------------------------------------------------------------

const WEAK_SECURITY_SCORE: Record<"open" | "wep" | "wpa", number> = { open: 7.5, wep: 8.1, wpa: 5.9 };

function findingsFromNetworks(networks: WifiNetwork[]): ScanOutput {
  const findings: Finding[] = [];
  const passedControls: PassedControl[] = [];
  // De-dupe by SSID+BSSID: the same AP is commonly seen once per band/channel.
  const seen = new Set<string>();
  for (const net of networks) {
    const key = `${net.ssid}|${net.bssid ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (net.security === "open" || net.security === "wep" || net.security === "wpa") {
      const score = WEAK_SECURITY_SCORE[net.security];
      const label = net.security === "open" ? "no encryption (open network)" : net.security === "wep" ? "WEP" : "WPA (no WPA2/WPA3)";
      findings.push({
        id: `wifi-weak-security-${key}`,
        title: `Wi-Fi Network Using ${label}`,
        severity: severityFromScore(score),
        cvssScore: score,
        cwe: "CWE-326",
        description: `Nearby network "${net.ssid}"${net.bssid ? ` (${net.bssid})` : ""} advertises ${label}.`,
        evidence: net.raw,
        impact:
          net.security === "open"
            ? "Traffic on an open network is unencrypted at the link layer and trivially interceptable by anyone in range."
            : "This encryption scheme has known practical attacks (key recovery for WEP; downgrade/dictionary attacks for WPA-only) and should not be relied on.",
        remediation: "Reconfigure the access point for WPA2 or WPA3 with a strong passphrase; retire WEP/open networks entirely.",
        affectedEndpoint: net.ssid,
      });
    } else if (net.security === "wpa2" || net.security === "wpa3") {
      passedControls.push({ label: `${net.ssid}`, detail: `Using ${net.security.toUpperCase()}.` });
    }
  }
  return { findings, passedControls };
}

// --- tool ------------------------------------------------------------

export interface SecurityScanWifiOptions {
  airportBinary?: string;
  systemProfilerBinary?: string;
  nmcliBinary?: string;
  iwlistBinary?: string;
  netshBinary?: string;
  /** Test-only: override process.platform's value. */
  platformOverride?: NodeJS.Platform;
}

export function createSecurityScanWifiTool(options: SecurityScanWifiOptions = {}): ToolDefinition<Record<string, never>> {
  const platform = options.platformOverride ?? process.platform;
  const airportBin = options.airportBinary ?? DEFAULT_AIRPORT_BIN;
  const systemProfilerBin = options.systemProfilerBinary ?? "system_profiler";
  const nmcliBin = options.nmcliBinary ?? "nmcli";
  const iwlistBin = options.iwlistBinary ?? "iwlist";
  const netshBin = options.netshBinary ?? "netsh";

  return {
    name: "security_scan_wifi",
    description:
      "Wi-Fi reconnaissance: passively lists nearby wireless networks (SSID/BSSID/channel/signal/security type) " +
      "using each OS's own standard tooling — no special hardware or drivers required. macOS: the `airport -s` " +
      "utility if still present (Apple has removed it on some macOS versions), falling back to " +
      "`system_profiler SPAirPortDataType` for just the currently-associated network's details when it's gone. " +
      "Linux: `nmcli device wifi list`, falling back to `iwlist scan` (often needs root). Windows: `netsh wlan " +
      "show networks mode=bssid` (best-effort, unverified on real Windows hardware). Flags open/WEP/WPA-only " +
      "networks as findings. " +
      "OUT OF SCOPE, not implemented here: monitor mode, packet injection, deauthentication attacks, WPA " +
      "handshake capture or offline cracking, and anything requiring a specialized adapter in monitor mode — " +
      "those need dedicated hardware/drivers this tool can't assume exist, and several of them are attack " +
      "actions against a network's other clients rather than passive enumeration.",
    // Passive scanning only (the radio listens to beacon frames already being
    // broadcast — the same signal any device in range receives just by
    // existing), no packets sent to any target — same tier as recon.ts's
    // passive DNS/WHOIS lookups and list_usb_devices' passive enumeration.
    riskLevel: "safe",
    inputSchema: { type: "object", properties: {} },
    describeCall: () => "scan for nearby Wi-Fi networks",
    async handler() {
      const notes: string[] = [];
      let networks: WifiNetwork[] = [];

      if (platform === "darwin") {
        const airport = await scanMacAirport(airportBin);
        notes.push(airport.available ? airport.note : airport.note);
        if (airport.available && airport.networks.length > 0) {
          networks = airport.networks;
        } else {
          const sp = await scanMacSystemProfiler(systemProfilerBin);
          notes.push(sp.note);
          networks = sp.networks;
        }
      } else if (platform === "linux") {
        const nmcli = await scanLinuxNmcli(nmcliBin);
        notes.push(nmcli.available ? nmcli.note : `nmcli unavailable: ${nmcli.note}`);
        if (nmcli.available) {
          networks = nmcli.networks;
        } else {
          const iwlist = await scanLinuxIwlist(iwlistBin);
          notes.push(iwlist.available ? iwlist.note : `iwlist unavailable: ${iwlist.note}`);
          networks = iwlist.networks;
        }
      } else if (platform === "win32") {
        const netsh = await scanWindowsNetsh(netshBin);
        notes.push(netsh.available ? netsh.note : `netsh unavailable: ${netsh.note}`);
        networks = netsh.networks;
      } else {
        notes.push(`No Wi-Fi scanning implemented for platform "${platform}".`);
      }

      if (networks.length === 0) {
        return { content: `No nearby Wi-Fi networks found or enumerable.\n\n--- detection methods ---\n${notes.join("\n")}`, isError: false, metadata: { networks: [] } };
      }

      const output = findingsFromNetworks(networks);
      const body = formatScanOutput("nearby Wi-Fi networks", output);
      return { content: `${body}\n\n--- detection methods ---\n${notes.join("\n")}`, isError: false, metadata: { networks } };
    },
  };
}
