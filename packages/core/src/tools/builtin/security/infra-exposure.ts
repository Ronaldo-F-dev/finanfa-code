import net from "node:net";
import { createHash } from "node:crypto";
import type { ToolDefinition } from "../../../core/types.js";
import { severityFromScore } from "./cvss.js";
import { formatScanOutput, type Finding, type ScanOutput } from "./types.js";

// Direct port of cyberlens's infra_exposure.py — detects commonly exposed
// infrastructure/admin services on the target's own hostname (never a
// different host, so this stays within the same authorization boundary as
// the rest of the scan): Elasticsearch/Kibana/Grafana/Prometheus/RabbitMQ/
// Docker API/K8s Dashboard/MinIO/Jenkins over HTTP, plus Redis/MySQL/
// PostgreSQL raw wire protocols, plus an MSSQL PRELOGIN-only reachability
// check. MySQL/Postgres go one step further than a banner grab: they
// complete the real handshake against well-known DEFAULT credentials only
// (never brute-forcing/guessing) — a Finding only fires on confirmed
// access (successful auth, or auth not required at all), never merely
// because a port is open. Implemented with Node's crypto/net directly
// (no new dependency), same approach as cyberlens's own hand-rolled
// protocol handling.
const PROBE_TIMEOUT_MS = 4_000;

const MYSQL_DEFAULT_CREDENTIALS: [string, string][] = [
  ["root", ""],
  ["root", "root"],
  ["root", "toor"],
  ["admin", "admin"],
];
const POSTGRES_DEFAULT_CREDENTIALS: [string, string][] = [
  ["postgres", "postgres"],
  ["postgres", "password"],
];

interface HttpServiceSpec {
  name: string;
  port: number;
  path: string;
  cwe: string;
  score: number;
  matches: (status: number, headers: Headers, body: string) => boolean;
}

const HTTP_SERVICES: HttpServiceSpec[] = [
  { name: "Elasticsearch", port: 9200, path: "/", cwe: "CWE-306", score: 8.6, matches: (s, _h, b) => s === 200 && b.includes('"cluster_name"') },
  { name: "Kibana", port: 5601, path: "/app/kibana", cwe: "CWE-306", score: 6.5, matches: (s, _h, b) => s === 200 && b.toLowerCase().includes("kibana") },
  { name: "Grafana", port: 3000, path: "/login", cwe: "CWE-306", score: 6.5, matches: (s, _h, b) => s === 200 && b.toLowerCase().includes("grafana") },
  { name: "Prometheus", port: 9090, path: "/graph", cwe: "CWE-200", score: 5.3, matches: (s, _h, b) => s === 200 && b.toLowerCase().includes("prometheus") },
  { name: "RabbitMQ Management", port: 15672, path: "/", cwe: "CWE-306", score: 6.5, matches: (s, _h, b) => s === 200 && b.toLowerCase().includes("rabbitmq") },
  { name: "Docker API", port: 2375, path: "/version", cwe: "CWE-306", score: 9.8, matches: (s, _h, b) => s === 200 && b.toLowerCase().includes('"apiversion"') },
  { name: "Kubernetes Dashboard", port: 30000, path: "/", cwe: "CWE-306", score: 8.6, matches: (s, _h, b) => s === 200 && b.toLowerCase().includes("kubernetes") },
  { name: "MinIO Console", port: 9001, path: "/", cwe: "CWE-306", score: 7.5, matches: (s, _h, b) => s === 200 && b.toLowerCase().includes("minio") },
  {
    name: "Jenkins",
    port: 8080,
    path: "/login",
    cwe: "CWE-306",
    score: 7.5,
    matches: (s, h, b) => s === 200 && (b.toLowerCase().includes("jenkins") || h.has("x-jenkins")),
  },
];

function finding(score: number, rest: Omit<Finding, "severity" | "cvssScore">): Finding {
  return { ...rest, severity: severityFromScore(score), cvssScore: score };
}

async function checkHttpService(scheme: string, hostname: string, spec: HttpServiceSpec): Promise<Finding | undefined> {
  const url = `${scheme}://${hostname}:${spec.port}${spec.path}`;
  let response: Response;
  try {
    response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  } catch {
    return undefined;
  }
  const body = await response.text().catch(() => "");
  if (!spec.matches(response.status, response.headers, body)) return undefined;

  return finding(spec.score, {
    id: `infra-exposed-${spec.name.toLowerCase().replace(/ /g, "-")}`,
    title: `${spec.name} Exposed on Default Port`,
    cvssVector: "AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:L/A:N",
    cwe: spec.cwe,
    description: `${spec.name} is reachable on its default port (${spec.port}) without an authentication wall in front of it.`,
    evidence: `GET ${url} -> HTTP ${response.status}, response matched a ${spec.name} fingerprint.`,
    impact: `An exposed ${spec.name} instance typically allows unauthenticated read (and often write/admin) access to its data or control plane.`,
    remediation: `Restrict ${spec.name} to internal networks only (firewall/VPC rules), and require authentication in front of it if it must be reachable externally.`,
    affectedEndpoint: url,
  });
}

// ---------- raw TCP helper ----------

function connectAndExchange(hostname: string, port: number, send: (socket: net.Socket) => void, readBytes = 4096): Promise<Buffer | undefined> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: hostname, port, timeout: PROBE_TIMEOUT_MS });
    let resolved = false;
    const finish = (result: Buffer | undefined) => {
      if (resolved) return;
      resolved = true;
      socket.destroy();
      resolve(result);
    };
    socket.on("connect", () => send(socket));
    socket.once("data", (chunk) => finish(chunk.subarray(0, readBytes)));
    socket.on("timeout", () => finish(undefined));
    socket.on("error", () => finish(undefined));
  });
}

// ---------- Redis (RESP, PING only) ----------

export async function checkRedis(hostname: string, port = 6379): Promise<Finding | undefined> {
  const response = await connectAndExchange(hostname, port, (s) => s.write("PING\r\n"), 64);
  if (!response) return undefined;
  if (!response.toString("latin1").startsWith("+PONG")) return undefined; // includes -NOAUTH: auth is actually required, not exposed

  const score = 8.6;
  return finding(score, {
    id: "infra-exposed-redis",
    title: "Redis Exposed on Default Port Without Authentication",
    cvssVector: "AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:N",
    cwe: "CWE-306",
    description: "Redis on port 6379 responds to commands without requiring authentication.",
    evidence: `PING sent to ${hostname}:${port} -> ${JSON.stringify(response.toString("latin1"))}`,
    impact: "An attacker can read/write all data in Redis, and in many configurations abuse CONFIG SET to write arbitrary files (a common path to remote code execution).",
    remediation: "Require authentication (requirepass / ACLs) and restrict network access to Redis to trusted internal hosts only.",
    affectedEndpoint: `${hostname}:${port}`,
  });
}

// ---------- MySQL wire protocol (client/server handshake, protocol 41) ----------

function parseMysqlHandshake(data: Buffer): { version: string; salt: Buffer } | undefined {
  try {
    if (data.length < 5) return undefined;
    const payload = data.subarray(4);
    if (payload.length === 0 || payload[0] !== 0x0a) return undefined;
    let idx = 1;
    const end = payload.indexOf(0x00, idx);
    if (end === -1) return undefined;
    const version = payload.subarray(idx, end).toString("latin1");
    idx = end + 1 + 4; // skip connection id
    const salt1 = payload.subarray(idx, idx + 8);
    idx += 8 + 1 + 2; // skip filler + capability flags (lower)
    if (idx >= payload.length) return { version, salt: salt1 };
    idx += 1 + 2 + 2; // skip charset + status flags + capability flags (upper)
    const authDataLen = idx < payload.length ? payload[idx] : 0;
    idx += 1 + 10; // skip reserved
    const salt2Len = Math.max(13, authDataLen - 8) - 1;
    const salt2 = payload.subarray(idx, idx + salt2Len);
    return { version, salt: Buffer.concat([salt1, salt2]) };
  } catch {
    return undefined;
  }
}

/** mysql_native_password challenge response: empty for an empty password, else SHA1(password) XOR SHA1(salt + SHA1(SHA1(password))). */
function mysqlNativePasswordResponse(password: string, salt: Buffer): Buffer {
  if (!password) return Buffer.alloc(0);
  const stage1 = createHash("sha1").update(password, "utf-8").digest();
  const stage2 = createHash("sha1").update(stage1).digest();
  const stage3 = createHash("sha1").update(Buffer.concat([salt, stage2])).digest();
  return Buffer.from(stage1.map((b, i) => b ^ stage3[i]));
}

function buildMysqlHandshakeResponse(username: string, authResponse: Buffer): Buffer {
  const CLIENT_LONG_PASSWORD = 0x00000001;
  const CLIENT_PROTOCOL_41 = 0x00000200;
  const CLIENT_SECURE_CONNECTION = 0x00008000;
  const CLIENT_PLUGIN_AUTH = 0x00080000;
  const capabilityFlags = CLIENT_LONG_PASSWORD | CLIENT_PROTOCOL_41 | CLIENT_SECURE_CONNECTION | CLIENT_PLUGIN_AUTH;

  const parts: Buffer[] = [];
  const capBuf = Buffer.alloc(4);
  capBuf.writeUInt32LE(capabilityFlags >>> 0, 0);
  parts.push(capBuf);
  const maxPacketBuf = Buffer.alloc(4);
  maxPacketBuf.writeUInt32LE(16777216, 0);
  parts.push(maxPacketBuf);
  parts.push(Buffer.from([0x21])); // charset: utf8_general_ci
  parts.push(Buffer.alloc(23)); // reserved
  parts.push(Buffer.from(`${username}\0`, "latin1"));
  parts.push(Buffer.from([authResponse.length]), authResponse);
  parts.push(Buffer.from("mysql_native_password\0", "latin1"));

  const payload = Buffer.concat(parts);
  const header = Buffer.alloc(4);
  header.writeUIntLE(payload.length, 0, 3);
  header[3] = 1; // sequence number 1
  return Buffer.concat([header, payload]);
}

export async function checkMysql(hostname: string, port = 3306): Promise<Finding | undefined> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: hostname, port, timeout: PROBE_TIMEOUT_MS });
    let stage: "handshake" | "auth" = "handshake";
    let credIndex = 0;
    let parsed: { version: string; salt: Buffer } | undefined;
    let settled = false;

    const finish = (result: Finding | undefined) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    const tryNextCredential = () => {
      if (credIndex >= MYSQL_DEFAULT_CREDENTIALS.length || !parsed) return finish(undefined);
      const [username, password] = MYSQL_DEFAULT_CREDENTIALS[credIndex];
      credIndex++;
      const authResponse = mysqlNativePasswordResponse(password, parsed.salt);
      socket.write(buildMysqlHandshakeResponse(username, authResponse));
    };

    socket.on("data", (chunk) => {
      if (stage === "handshake") {
        parsed = parseMysqlHandshake(chunk);
        if (!parsed) return finish(undefined);
        stage = "auth";
        tryNextCredential();
        return;
      }
      // auth reply
      if (chunk.length > 4 && chunk[4] === 0x00 && parsed) {
        const [username, password] = MYSQL_DEFAULT_CREDENTIALS[credIndex - 1];
        const score = 9.8;
        return finish(
          finding(score, {
            id: "infra-exposed-mysql-default-credentials",
            title: "MySQL Accessible With Default Credentials",
            cvssVector: "AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H",
            cwe: "CWE-521",
            description: `MySQL on port ${port} (${parsed.version}) accepted the default credential pair '${username}'/'${password || "(empty)"}'.`,
            evidence: `MySQL handshake version: ${parsed.version}; login with ${username}/${password || "(empty)"} succeeded (OK packet returned).`,
            impact: "Full read/write access to every database on the server — a default-credential MySQL login is equivalent to a full compromise of all data it holds.",
            remediation: "Set a strong, unique root/admin password immediately, remove default accounts, and restrict network access to trusted internal hosts only.",
            affectedEndpoint: `${hostname}:${port}`,
          }),
        );
      }
      // A real connection only allows one login attempt before the server
      // closes it on failure — same minimal-footprint stance as cyberlens's
      // own Postgres check below: stop after the first attempt rather than
      // reconnecting per credential.
      finish(undefined);
    });
    socket.on("timeout", () => finish(undefined));
    socket.on("error", () => finish(undefined));
  });
}

// ---------- PostgreSQL frontend/backend protocol (v3) ----------

function buildPostgresStartup(user: string): Buffer {
  const params = Buffer.from(`user\0${user}\0database\0${user}\0\0`, "latin1");
  const length = 4 + 4 + params.length;
  const header = Buffer.alloc(8);
  header.writeUInt32BE(length, 0);
  header.writeUInt32BE(196608, 4); // protocol 3.0
  return Buffer.concat([header, params]);
}

interface PostgresMessage {
  type: "auth" | "error";
  authType?: number;
  salt?: Buffer;
}

function parsePostgresMessage(data: Buffer): PostgresMessage | undefined {
  try {
    if (data.length < 5 || (data[0] !== 0x52 && data[0] !== 0x45)) return undefined; // 'R' or 'E'
    if (data[0] === 0x45) return { type: "error" };
    if (data.length < 9) return { type: "auth", authType: undefined };
    const authType = data.readUInt32BE(5);
    const salt = authType === 5 && data.length >= 13 ? data.subarray(9, 13) : undefined;
    return { type: "auth", authType, salt };
  } catch {
    return undefined;
  }
}

function postgresMd5Password(password: string, user: string, salt: Buffer): Buffer {
  const inner = createHash("md5").update(password + user, "utf-8").digest("hex");
  const outer = createHash("md5").update(Buffer.concat([Buffer.from(inner, "latin1"), salt])).digest("hex");
  return Buffer.from(`md5${outer}\0`, "latin1");
}

function buildPostgresPasswordMessage(passwordPayload: Buffer): Buffer {
  const length = 4 + passwordPayload.length;
  const header = Buffer.alloc(5);
  header[0] = 0x70; // 'p'
  header.writeUInt32BE(length, 1);
  return Buffer.concat([header.subarray(0, 1), header.subarray(1), passwordPayload]);
}

export async function checkPostgresql(hostname: string, port = 5432): Promise<Finding | undefined> {
  const first = await connectAndExchange(hostname, port, (s) => s.write(buildPostgresStartup("postgres")));
  if (!first) return undefined;
  const parsed = parsePostgresMessage(first);
  if (!parsed) return undefined;

  if (parsed.type === "auth" && parsed.authType === 0) {
    const score = 9.8;
    return finding(score, {
      id: "infra-exposed-postgresql-no-auth",
      title: "PostgreSQL Accepts Connections Without a Password",
      cvssVector: "AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H",
      cwe: "CWE-521",
      description: "PostgreSQL on port " + port + " authenticated the 'postgres' user with no password at all (trust/peer-equivalent authentication exposed over the network).",
      evidence: "Startup message for user 'postgres' -> AuthenticationOk with no password challenge.",
      impact: "Full read/write access to every database on the server with no credential required whatsoever.",
      remediation: "Set pg_hba.conf to require md5/scram-sha-256 authentication for network connections; never use 'trust' for non-local connections.",
      affectedEndpoint: `${hostname}:${port}`,
    });
  }

  if (parsed.type !== "auth" || (parsed.authType !== 3 && parsed.authType !== 5)) return undefined;

  // Same minimal-footprint stance as MySQL above: a failed auth attempt
  // closes the connection server-side, so this stops after the first
  // credential rather than reconnecting per candidate.
  const [username, password] = POSTGRES_DEFAULT_CREDENTIALS[0];
  const passwordPayload = parsed.authType === 5 && parsed.salt ? postgresMd5Password(password, username, parsed.salt) : Buffer.from(`${password}\0`, "latin1");

  const reply = await connectAndExchange(hostname, port, async (s) => {
    s.write(buildPostgresStartup(username));
    // The startup message triggers the same auth challenge again on a
    // fresh connection; write the password response right after.
    await new Promise((r) => setTimeout(r, 50));
    s.write(buildPostgresPasswordMessage(passwordPayload));
  });
  if (!reply) return undefined;
  const replyParsed = parsePostgresMessage(reply);
  if (replyParsed?.type === "auth" && replyParsed.authType === 0) {
    const score = 9.8;
    return finding(score, {
      id: "infra-exposed-postgresql-default-credentials",
      title: "PostgreSQL Accessible With Default Credentials",
      cvssVector: "AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H",
      cwe: "CWE-521",
      description: `PostgreSQL on port ${port} accepted the default credential pair '${username}'/'${password}'.`,
      evidence: `Login with ${username}/${password} succeeded (AuthenticationOk returned).`,
      impact: "Full read/write access to every database on the server — a default-credential PostgreSQL login is equivalent to a full compromise of all data it holds.",
      remediation: "Set a strong, unique password for every role immediately, remove default accounts, and restrict network access to trusted internal hosts only.",
      affectedEndpoint: `${hostname}:${port}`,
    });
  }
  return undefined;
}

// ---------- MSSQL TDS protocol (PRELOGIN only) ----------

function buildMssqlPrelogin(): Buffer {
  const ENCRYPT_NOT_SUPPORTED = 0x02;
  const OPTION_TOKEN_ENCRYPTION = 0x01;
  const TERMINATOR = 0xff;

  const optionData = Buffer.from([ENCRYPT_NOT_SUPPORTED]);
  const headerLen = 5 + 1;
  const optionHeader = Buffer.alloc(5);
  optionHeader[0] = OPTION_TOKEN_ENCRYPTION;
  optionHeader.writeUInt16BE(headerLen, 1);
  optionHeader.writeUInt16BE(optionData.length, 3);
  const payload = Buffer.concat([optionHeader, Buffer.from([TERMINATOR]), optionData]);

  const packetType = 0x12;
  const status = 0x01;
  const length = 8 + payload.length;
  const tdsHeader = Buffer.alloc(8);
  tdsHeader[0] = packetType;
  tdsHeader[1] = status;
  tdsHeader.writeUInt16BE(length, 2);
  return Buffer.concat([tdsHeader, payload]);
}

export async function checkMssql(hostname: string, port = 1433): Promise<Finding | undefined> {
  const response = await connectAndExchange(hostname, port, (s) => s.write(buildMssqlPrelogin()));
  if (!response || response.length < 8 || response[0] !== 0x04) return undefined; // not a TDS PRELOGIN response

  return {
    id: "infra-exposed-mssql-reachable",
    title: "MSSQL Port Reachable From the Network",
    severity: "INFO",
    description: "A SQL Server instance on port 1433 responded to a TDS PRELOGIN request. This confirms the port is reachable but does not test credentials (a full login requires TLS/encryption negotiation this tool does not attempt).",
    evidence: `TDS PRELOGIN sent to ${hostname}:${port} -> ${response.length}-byte response, packet type 0x04 (TABULAR_RESULT).`,
    impact: "Every additional network-reachable database port widens the attack surface available to credential-stuffing/brute-force attempts, even before considering specific CVEs.",
    remediation: "Restrict MSSQL to internal networks/VPNs only; it should not be reachable directly from the public internet.",
    affectedEndpoint: `${hostname}:${port}`,
  };
}

async function scanInfraExposure(targetUrl: string): Promise<ScanOutput> {
  let target: URL;
  try {
    target = new URL(targetUrl);
  } catch {
    throw new Error(`"${targetUrl}" is not a valid URL.`);
  }
  const hostname = target.hostname;
  if (!hostname) throw new Error(`"${targetUrl}" has no hostname.`);
  const scheme = target.protocol.replace(":", "") || "http";

  const httpResults = await Promise.all(HTTP_SERVICES.map((spec) => checkHttpService(scheme, hostname, spec)));
  const dbResults = await Promise.all([checkRedis(hostname), checkMysql(hostname), checkPostgresql(hostname)]);
  const mssqlResult = await checkMssql(hostname);

  const findings = [...httpResults, ...dbResults, mssqlResult].filter((f): f is Finding => Boolean(f));

  if (findings.length === 0) {
    return {
      findings: [],
      passedControls: [
        {
          label: "No exposed infrastructure services detected",
          detail: `None of ${HTTP_SERVICES.length + 4} common admin/data-store services responded on their default ports (or none allowed unauthenticated/default-credential access).`,
        },
      ],
    };
  }

  return { findings, passedControls: [] };
}

interface SecurityScanInfraExposureInput {
  url: string;
}

export const securityScanInfraExposureTool: ToolDefinition<SecurityScanInfraExposureInput> = {
  name: "security_scan_infra_exposure",
  description:
    "Security tool. Probes the target's own hostname for commonly exposed infrastructure/admin services on " +
    "their well-known default ports: Elasticsearch, Kibana, Grafana, Prometheus, RabbitMQ Management, Docker " +
    "API, Kubernetes Dashboard, MinIO Console, Jenkins (HTTP fingerprints), plus Redis (unauthenticated PING), " +
    "MySQL and PostgreSQL (completes the real wire-protocol handshake against a short list of well-known " +
    "DEFAULT credentials only — never brute-forcing/guessing; a finding only fires on confirmed access), and " +
    "MSSQL (reachability only, via TDS PRELOGIN — a full login needs a TLS negotiation this doesn't attempt). " +
    "Never probes a different host than the target's own hostname. A faithful port of the user's own cyberlens " +
    "scanner's infra_exposure check. " +
    "IMPORTANT: only scan a target the user owns or has explicit, documented authorization to test.",
  riskLevel: "ask",
  inputSchema: {
    type: "object",
    properties: { url: { type: "string", description: "Target URL, e.g. https://example.com — its hostname's common infra ports are probed" } },
    required: ["url"],
  },
  describeCall: (input) => `probe for exposed infrastructure: ${input.url}`,
  async handler(input) {
    try {
      const output = await scanInfraExposure(input.url);
      return { content: formatScanOutput(input.url, output), isError: false };
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), isError: true };
    }
  },
};
