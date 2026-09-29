import net from "node:net";
import type { ToolDefinition } from "../../../core/types.js";

// Generic nmap-style TCP connect-scan, implemented directly with net.Socket
// (no shelling out to a possibly-absent `nmap` binary) — same raw-socket
// approach as infra-exposure.ts/recon.ts elsewhere in this directory.
// Unlike infra-exposure.ts (which only probes a fixed list of known service
// ports on the target's own hostname), this scans an arbitrary port
// list/range on an arbitrary host, so it's a strictly broader network
// action — see the riskLevel note on the tool below.
const CONNECT_TIMEOUT_MS = 3_000;
const MAX_CONCURRENCY = 50;
const MAX_PORTS_PER_SCAN = 4_096; // guards against an accidental/near-full 1-65535 sweep

// Reuses the same well-known ports infra-exposure.ts already fingerprints,
// plus the other most commonly scanned ports, rather than inventing a
// second port->service table.
const WELL_KNOWN_SERVICES: Record<number, string> = {
  21: "ftp",
  22: "ssh",
  23: "telnet",
  25: "smtp",
  53: "dns",
  80: "http",
  110: "pop3",
  111: "rpcbind",
  135: "msrpc",
  139: "netbios-ssn",
  143: "imap",
  443: "https",
  445: "microsoft-ds",
  993: "imaps",
  995: "pop3s",
  1433: "mssql",
  1521: "oracle",
  2375: "docker",
  3000: "grafana",
  3306: "mysql",
  3389: "rdp",
  5432: "postgresql",
  5601: "kibana",
  5900: "vnc",
  6379: "redis",
  8080: "http-alt",
  8443: "https-alt",
  9000: "sonarqube",
  9090: "prometheus",
  9200: "elasticsearch",
  9201: "minio-console",
  15672: "rabbitmq-management",
  27017: "mongodb",
  30000: "kubernetes-dashboard",
};

// Default scope when the caller specifies neither `ports` nor a range: the
// top well-known service ports, not a full 1-65535 sweep — same
// scope-limiting stance as the other scan tools in this directory (e.g.
// infra-exposure.ts only ever probes a fixed default port list, never an
// open-ended range).
const DEFAULT_PORTS = [21, 22, 23, 25, 53, 80, 110, 111, 135, 139, 143, 443, 445, 993, 995, 1433, 1521, 2375, 3000, 3306, 3389, 5432, 5601, 5900, 6379, 8080, 8443, 9000, 9090, 9200, 9201, 15672, 27017, 30000];

export type PortState = "open" | "closed" | "filtered";

export interface PortScanResult {
  port: number;
  state: PortState;
  service?: string;
}

function guessService(port: number): string | undefined {
  return WELL_KNOWN_SERVICES[port];
}

function scanOnePort(hostname: string, port: number): Promise<PortScanResult> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: hostname, port, timeout: CONNECT_TIMEOUT_MS });
    let settled = false;
    const finish = (state: PortState) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ port, state, service: guessService(port) });
    };
    socket.on("connect", () => finish("open"));
    // A timeout with no connect/error/refusal is the classic "filtered"
    // signature (a firewall silently dropping the SYN rather than
    // responding with RST) — the same open/closed/filtered vocabulary
    // nmap itself uses for a TCP connect scan.
    socket.on("timeout", () => finish("filtered"));
    socket.on("error", (err: NodeJS.ErrnoException) => finish(err.code === "ECONNREFUSED" ? "closed" : "filtered"));
  });
}

/** Runs `run` over `items` with at most `limit` in flight at once — keeps this from opening thousands of sockets simultaneously. */
async function withConcurrency<T>(items: T[], limit: number, run: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      await run(items[index], index);
    }
  });
  await Promise.all(workers);
}

function parsePorts(input: SecurityScanPortsInput): number[] {
  let ports: number[];
  if (input.ports && input.ports.length > 0) {
    ports = input.ports;
  } else if (input.startPort !== undefined || input.endPort !== undefined) {
    const start = input.startPort ?? 1;
    const end = input.endPort ?? start;
    if (start < 1 || end > 65535 || start > end) throw new Error(`Invalid port range ${start}-${end}. Ports must be between 1 and 65535 with start <= end.`);
    ports = Array.from({ length: end - start + 1 }, (_, i) => start + i);
  } else {
    ports = DEFAULT_PORTS;
  }

  const unique = [...new Set(ports)];
  for (const p of unique) {
    if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error(`Invalid port ${p}. Ports must be integers between 1 and 65535.`);
  }
  if (unique.length > MAX_PORTS_PER_SCAN) {
    throw new Error(`Requested ${unique.length} ports, which exceeds the ${MAX_PORTS_PER_SCAN}-port limit per scan. Narrow the range or port list.`);
  }
  return unique;
}

async function scanPorts(hostname: string, ports: number[]): Promise<PortScanResult[]> {
  const results: PortScanResult[] = new Array(ports.length);
  await withConcurrency(ports, MAX_CONCURRENCY, async (port, index) => {
    results[index] = await scanOnePort(hostname, port);
  });
  return results.sort((a, b) => a.port - b.port);
}

function formatResults(hostname: string, results: PortScanResult[]): string {
  const open = results.filter((r) => r.state === "open");
  const lines = [`Port scan of ${hostname} (${results.length} port(s) checked): ${open.length} open.`];
  if (open.length > 0) {
    lines.push("");
    lines.push("Open ports:");
    for (const r of open) lines.push(`- ${r.port}${r.service ? `/tcp (${r.service})` : "/tcp"}: open`);
  }
  const nonOpen = results.filter((r) => r.state !== "open");
  if (nonOpen.length > 0) {
    const closed = nonOpen.filter((r) => r.state === "closed").length;
    const filtered = nonOpen.filter((r) => r.state === "filtered").length;
    lines.push("");
    lines.push(`Closed: ${closed}, filtered: ${filtered}.`);
  }
  return lines.join("\n");
}

interface SecurityScanPortsInput {
  host: string;
  ports?: number[];
  startPort?: number;
  endPort?: number;
}

export const securityScanPortsTool: ToolDefinition<SecurityScanPortsInput> = {
  name: "security_scan_ports",
  description:
    "Security tool. Generic TCP connect-scan against a given host: checks either an explicit port list or a " +
    "startPort/endPort range (default: a curated list of the most commonly exposed service ports, not a full " +
    "1-65535 sweep) and reports each port as open/closed/filtered, with a best-guess service name for " +
    "well-known ports. Implemented directly with Node's net.Socket (no nmap dependency), concurrency-limited " +
    `to ${MAX_CONCURRENCY} connections at once, capped at ${MAX_PORTS_PER_SCAN} ports per scan. Unlike ` +
    "security_scan_infra_exposure (which only probes a fixed list of known service ports on the target's own " +
    "hostname), this can scan any host across any ports you specify. " +
    "IMPORTANT: only scan a host the user owns or has explicit, documented authorization to test — this sends " +
    "real TCP connection attempts to whatever host is given, which can be logged/alerted on by the target and " +
    "may be against policy or law if unauthorized.",
  // Same "ask" tier as recon.ts/infra-exposure.ts: no exploit-style payload
  // is ever sent (just a TCP connect, the same signal any client makes),
  // but unlike those two this can target an arbitrary host/port set rather
  // than the given target's own hostname/well-known ports only, so
  // confirming authorization before every call matters even more here.
  riskLevel: "ask",
  inputSchema: {
    type: "object",
    properties: {
      host: { type: "string", description: "Target hostname or IP address to scan" },
      ports: { type: "array", items: { type: "number" }, description: "Explicit list of ports to scan. Takes precedence over startPort/endPort." },
      startPort: { type: "number", description: "Start of a port range to scan (inclusive). Defaults to 1 when only endPort is given." },
      endPort: { type: "number", description: "End of a port range to scan (inclusive). Defaults to startPort when only startPort is given." },
    },
    required: ["host"],
  },
  describeCall: (input) => `port scan: ${input.host}${input.ports ? ` (${input.ports.length} ports)` : input.startPort || input.endPort ? ` (${input.startPort ?? 1}-${input.endPort ?? input.startPort})` : " (default port list)"}`,
  async handler(input) {
    try {
      const ports = parsePorts(input);
      const results = await scanPorts(input.host, ports);
      return { content: formatResults(input.host, results), isError: false };
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), isError: true };
    }
  },
};
