import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { ToolDefinition } from "../../../core/types.js";
import { isCommandAvailable } from "../../../util/command-availability.js";

// Wi-Fi capture-file management, ported from wireless-lab's wifi/capture
// (passive.ts + metadata.ts): runs a bounded, finite `tcpdump` capture on an
// interface in whatever mode it's already in (never enables monitor mode —
// that's a materially different, attack-adjacent operation, left to
// security_wifi_active_handshake_capture's still-unimplemented stub), and
// tracks the resulting .pcap file with a JSON metadata sidecar so captures
// can be listed/found again without re-parsing every file on disk.
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_PACKET_COUNT = 50;
const DEFAULT_OUTPUT_DIR = "./captures";

export interface CaptureMetadata {
  id: string;
  interfaceName: string;
  filePath: string;
  requestedPackets: number;
  startedAt: string;
  finishedAt: string;
  fileSizeBytes: number;
}

function metadataSidecarPath(capturePath: string): string {
  return `${capturePath}.meta.json`;
}

async function writeCaptureMetadata(metadata: CaptureMetadata): Promise<string> {
  const sidecar = metadataSidecarPath(metadata.filePath);
  await fs.writeFile(sidecar, JSON.stringify(metadata, null, 2), "utf-8");
  return sidecar;
}

/** Lists every capture recorded in `dir` by reading each `.meta.json`
 * sidecar — capture *file* bookkeeping (naming, discovery, timing), not
 * analysis of the packets inside (see security_scan_wifi's captureFilePath
 * for that). */
export async function listCaptures(dir: string): Promise<CaptureMetadata[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const metadataFiles = entries.filter((e) => e.endsWith(".meta.json"));
  const results: CaptureMetadata[] = [];
  for (const file of metadataFiles) {
    try {
      const raw = await fs.readFile(path.join(dir, file), "utf-8");
      results.push(JSON.parse(raw) as CaptureMetadata);
    } catch {
      // Skip a corrupt/partial sidecar rather than failing the whole listing.
    }
  }
  return results.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
  error?: NodeJS.ErrnoException;
}

function run(bin: string, args: string[], timeoutMs: number): Promise<RunResult> {
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

// --- Wi-Fi interface enumeration + monitor-mode detection (Linux `iw`) ----
// Ported from wireless-lab's platform/wifi-interfaces.ts. Used by this
// file's own prerequisite checks and re-exported for
// security_wifi_active_handshake_capture's stub prerequisite check.

export interface WifiInterface {
  name: string;
  /** True only when `iw phy <phy> info` reports monitor mode among its
   * supported interface modes. macOS/Windows have no standard-tooling
   * equivalent for this, so it's left `undefined` (unknown) there rather
   * than guessed. */
  supportsMonitorMode?: boolean;
}

function parseIwDevInterfaceNames(stdout: string): string[] {
  const names: string[] = [];
  for (const line of stdout.split("\n")) {
    const m = /Interface\s+(\S+)/.exec(line);
    if (m) names.push(m[1]);
  }
  return names;
}

function phySupportsMonitorMode(phyInfoStdout: string): boolean {
  return /Supported interface modes:[\s\S]*?\*\s*monitor/.test(phyInfoStdout);
}

/** Linux only (`iw dev` + `iw phy <phy> info`) — monitor-mode capability is
 * a phy-level (radio chip), not interface-level, property. Returns an empty
 * list, rather than throwing, when `iw` isn't installed or the platform
 * isn't Linux. */
export async function listWifiInterfacesLinux(iwBin = "iw"): Promise<WifiInterface[]> {
  if (!isCommandAvailable(iwBin)) return [];
  const devResult = await run(iwBin, ["dev"], DEFAULT_TIMEOUT_MS);
  if (devResult.code !== 0) return [];

  const wiphyByInterface = new Map<string, string>();
  let currentPhy: string | undefined;
  for (const line of devResult.stdout.split("\n")) {
    const phyMatch = /phy#(\d+)/.exec(line);
    if (phyMatch) currentPhy = phyMatch[1];
    const ifaceMatch = /Interface\s+(\S+)/.exec(line);
    if (ifaceMatch && currentPhy) wiphyByInterface.set(ifaceMatch[1], currentPhy);
  }

  const names = parseIwDevInterfaceNames(devResult.stdout);
  const interfaces: WifiInterface[] = [];
  for (const name of names) {
    const phy = wiphyByInterface.get(name);
    if (phy === undefined) {
      interfaces.push({ name });
      continue;
    }
    const info = await run(iwBin, ["phy", `phy${phy}`, "info"], DEFAULT_TIMEOUT_MS);
    interfaces.push({ name, supportsMonitorMode: info.code === 0 ? phySupportsMonitorMode(info.stdout) : undefined });
  }
  return interfaces;
}

// --- security_start_wifi_capture ------------------------------------------

export interface StartWifiCaptureOptions {
  tcpdumpBinary?: string;
}

interface StartWifiCaptureInput {
  interfaceName: string;
  outputDir?: string;
  packetCount?: number;
}

export function createSecurityStartWifiCaptureTool(options: StartWifiCaptureOptions = {}): ToolDefinition<StartWifiCaptureInput> {
  const tcpdumpBin = options.tcpdumpBinary ?? "tcpdump";

  return {
    name: "security_start_wifi_capture",
    description:
      "Runs a real, bounded `tcpdump -i <interface> -w <file> -c <packetCount>` capture on a Wi-Fi interface in " +
      "whatever mode it's already in (never enables monitor mode), writes the resulting .pcap file plus a JSON " +
      "metadata sidecar (id/interface/timing/size), and returns the capture's id and file path. Analyze the " +
      "result with security_scan_wifi's captureFilePath input, or list past captures with " +
      "security_list_wifi_captures. Often needs elevated privileges (root/CAP_NET_RAW) depending on the OS and " +
      "interface. OUT OF SCOPE: monitor mode / packet injection — see security_wifi_active_handshake_capture.",
    // Passive: tcpdump only records frames the interface already receives in
    // its current mode, same "listening only" tier as security_scan_wifi —
    // but unlike that tool this spawns a real subprocess that writes a file
    // to disk, so it's a step up from "safe" rather than identical to it.
    riskLevel: "ask",
    inputSchema: {
      type: "object",
      properties: {
        interfaceName: { type: "string", description: "Interface to capture on (e.g. wlan0, en0)" },
        outputDir: { type: "string", description: `Directory to write the capture + metadata sidecar into (default "${DEFAULT_OUTPUT_DIR}")` },
        packetCount: { type: "number", description: `Number of packets to capture before stopping (default ${DEFAULT_PACKET_COUNT})` },
      },
      required: ["interfaceName"],
    },
    riskKey: (input) => `security_start_wifi_capture:${input.interfaceName}`,
    describeCall: (input) => `tcpdump -i ${input.interfaceName} (capture ${input.packetCount ?? DEFAULT_PACKET_COUNT} packets)`,
    async handler(input) {
      if (!isCommandAvailable(tcpdumpBin)) {
        return { content: "tcpdump not found — install it via your OS package manager (it ships by default on macOS; `apt install tcpdump` on Debian/Ubuntu).", isError: true };
      }

      const outputDir = input.outputDir ?? DEFAULT_OUTPUT_DIR;
      try {
        await fs.mkdir(outputDir, { recursive: true });
        await fs.access(outputDir, fs.constants.W_OK);
      } catch (err) {
        return { content: `Output directory "${outputDir}" is not writable: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }

      const packetCount = input.packetCount ?? DEFAULT_PACKET_COUNT;
      const id = crypto.randomUUID();
      const filePath = path.join(outputDir, `capture-${id}.pcap`);
      const startedAt = new Date();

      const result = await run(tcpdumpBin, ["-i", input.interfaceName, "-w", filePath, "-c", String(packetCount)], DEFAULT_TIMEOUT_MS);
      const finishedAt = new Date();

      if (result.error) {
        return { content: `Failed to run tcpdump: ${result.error.message}`, isError: true };
      }
      if (result.code !== 0) {
        const permissionHint = /permission|not permitted|operation not permitted/i.test(result.stderr) ? " (tcpdump often needs root/CAP_NET_RAW to capture raw frames)" : "";
        return { content: `tcpdump exited with code ${result.code}${permissionHint}: ${result.stderr.trim()}`, isError: true };
      }

      let stat;
      try {
        stat = await fs.stat(filePath);
      } catch (err) {
        return { content: `tcpdump exited cleanly but the capture file wasn't found: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }

      const metadata: CaptureMetadata = {
        id,
        interfaceName: input.interfaceName,
        filePath,
        requestedPackets: packetCount,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        fileSizeBytes: stat.size,
      };
      const sidecarPath = await writeCaptureMetadata(metadata);

      return {
        content: `Captured ${stat.size} bytes to ${filePath} (id ${id}), metadata sidecar at ${sidecarPath}. Analyze it with security_scan_wifi({ captureFilePath: "${filePath}" }).`,
        isError: false,
        metadata: { capture: metadata },
      };
    },
  };
}

// --- security_list_wifi_captures ------------------------------------------

interface ListWifiCapturesInput {
  outputDir?: string;
}

export function createSecurityListWifiCapturesTool(): ToolDefinition<ListWifiCapturesInput> {
  return {
    name: "security_list_wifi_captures",
    description: `Lists Wi-Fi captures previously recorded by security_start_wifi_capture, by reading each capture's ".meta.json" sidecar in a directory (default "${DEFAULT_OUTPUT_DIR}") — pure filesystem bookkeeping, no packet parsing.`,
    riskLevel: "safe",
    inputSchema: {
      type: "object",
      properties: {
        outputDir: { type: "string", description: `Directory to list captures from (default "${DEFAULT_OUTPUT_DIR}")` },
      },
    },
    describeCall: (input) => `list Wi-Fi captures in ${input.outputDir ?? DEFAULT_OUTPUT_DIR}`,
    async handler(input) {
      const dir = input.outputDir ?? DEFAULT_OUTPUT_DIR;
      const captures = await listCaptures(dir);
      if (captures.length === 0) {
        return { content: `No captures found in "${dir}".`, isError: false, metadata: { captures: [] } };
      }
      const lines = captures.map((c) => `- ${c.id}: ${c.filePath} (${c.fileSizeBytes} bytes, ${c.requestedPackets} packets requested on ${c.interfaceName}, ${c.startedAt} → ${c.finishedAt})`);
      return { content: `${captures.length} capture(s) in "${dir}":\n${lines.join("\n")}`, isError: false, metadata: { captures } };
    },
  };
}
