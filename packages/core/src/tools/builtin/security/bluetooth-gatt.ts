import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

// Read-only BLE GATT discovery support, ported from wireless-lab's
// bluetooth/gatt package (session.ts + parsers.ts + index.ts's discovery
// flow). `bluetoothctl` has no non-interactive GATT query mode, so
// discovery/read has to drive the same menu-based interface a human would
// type into: write a line to stdin, give it a moment to respond, read back
// whatever printed. Used by bluetooth-scan.ts's deviceAddress sub-action.

/** Wraps `bluetoothctl` run with no subcommand (its interactive REPL).
 * There is no reliable end-of-response marker in bluetoothctl's output, so
 * a short quiet-period wait is used instead of trying to parse a prompt. */
export class BluetoothctlSession {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";

  constructor(private readonly bin: string) {}

  start(): void {
    this.child = spawn(this.bin, []);
    this.child.stdout.on("data", (d) => (this.buffer += d.toString()));
  }

  /** Sends a command and waits for its response: polls until output has
   * stopped arriving for `quietMs` in a row (rather than a single fixed
   * delay), so this stays reliable under CPU contention from other tests/
   * processes running concurrently. Gives up after `maxWaitMs` regardless,
   * returning whatever arrived. */
  async send(command: string, quietMs = 200, maxWaitMs = 3_000): Promise<string> {
    if (!this.child) throw new Error("BluetoothctlSession not started");
    this.buffer = "";
    this.child.stdin.write(`${command}\n`);

    const pollMs = 20;
    let elapsed = 0;
    let quietFor = 0;
    while (elapsed < maxWaitMs) {
      const before = this.buffer.length;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      elapsed += pollMs;
      if (this.buffer.length === before) {
        quietFor += pollMs;
        if (this.buffer.length > 0 && quietFor >= quietMs) break;
      } else {
        quietFor = 0;
      }
    }

    const output = this.buffer;
    this.buffer = "";
    return output;
  }

  close(): void {
    if (!this.child) return;
    this.child.stdin.write("quit\n");
    this.child.kill("SIGTERM");
    this.child = null;
  }
}

export interface GattAttribute {
  kind: "service" | "characteristic" | "descriptor";
  handle?: string;
  path: string;
  uuid: string;
  name?: string;
}

/** Parses `bluetoothctl`'s `list-attributes <device>` output (under `menu
 * gatt`). Each attribute prints as a 2-3 line group: a header line
 * ("Primary Service (Handle 0x0001)" / "Characteristic (Handle 0x0003)" /
 * "Descriptor (Handle ...)"), then an indented D-Bus object path, then an
 * indented UUID, optionally followed by a human-readable name line. */
export function parseListAttributes(stdout: string): GattAttribute[] {
  const lines = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const attributes: GattAttribute[] = [];
  let current: Partial<GattAttribute> | null = null;

  const flush = () => {
    if (current?.path && current.uuid && current.kind) attributes.push(current as GattAttribute);
    current = null;
  };

  for (const line of lines) {
    const headerMatch = /^(Primary Service|Service|Characteristic|Descriptor)\s*(?:\(Handle\s*(0x[0-9a-fA-F]+)\))?/.exec(line);
    if (headerMatch) {
      flush();
      const kind = headerMatch[1].toLowerCase().includes("service") ? "service" : headerMatch[1].toLowerCase().includes("descriptor") ? "descriptor" : "characteristic";
      current = { kind: kind as GattAttribute["kind"], handle: headerMatch[2] };
      continue;
    }
    if (!current) continue;
    if (line.startsWith("/org/bluez/")) {
      current.path = line;
      continue;
    }
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(line)) {
      current.uuid = line;
      continue;
    }
    // Anything else on a line after path+uuid are set is the human-readable name.
    if (current.path && current.uuid && !current.name) current.name = line;
  }
  flush();
  return attributes;
}

/** Parses `read`'s "Value: 57 69 72 65 ..." hex-byte line into a Buffer. */
export function parseReadValue(stdout: string): Buffer | undefined {
  const match = /Value:\s*((?:[0-9a-fA-F]{2}\s*)+)/.exec(stdout);
  if (!match) return undefined;
  const bytes = match[1]
    .trim()
    .split(/\s+/)
    .map((h) => parseInt(h, 16));
  return Buffer.from(bytes);
}

// Legacy/high-risk GATT service UUIDs, ported from wireless-lab's
// bluetooth/audit package — not exhaustive, a starting set covering the
// common "this is worth a second look" services.
const KNOWN_LEGACY_SERVICE_UUIDS = new Set<string>([
  "0000ffe0-0000-1000-8000-00805f9b34fb", // common vendor UART bridge, often used without app-layer auth
]);

export interface GattAuditFinding {
  uuid: string;
  title: string;
  description: string;
}

/** Flags known legacy/high-risk GATT service UUIDs among discovered
 * attributes. Ported from wireless-lab's bluetooth/audit package. */
export function auditGattAttributes(attributes: GattAttribute[]): GattAuditFinding[] {
  const findings: GattAuditFinding[] = [];
  for (const attr of attributes) {
    if (attr.kind !== "service") continue;
    if (KNOWN_LEGACY_SERVICE_UUIDS.has(attr.uuid.toLowerCase())) {
      findings.push({
        uuid: attr.uuid,
        title: "Legacy/vendor UART-bridge service exposed",
        description: `Service ${attr.uuid}${attr.name ? ` (${attr.name})` : ""} is a common raw-serial bridge often used without any application-layer authentication.`,
      });
    }
  }
  return findings;
}
