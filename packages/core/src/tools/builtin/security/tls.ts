import tls from "node:tls";
import type { ToolDefinition } from "../../../core/types.js";
import { severityFromScore } from "./cvss.js";
import { formatScanOutput, type Finding, type PassedControl, type ScanOutput } from "./types.js";

// Direct port of cyberlens's tls.py — same weak-protocol/cipher lists,
// expiry threshold, and CVSS vectors/CWEs.
const WEAK_PROTOCOLS = new Set(["SSLv2", "SSLv3", "TLSv1", "TLSv1.1"]);
const EXPIRY_WARNING_DAYS = 30;
const WEAK_CIPHER_MARKERS = ["RC4", "DES", "3DES", "NULL", "EXPORT", "MD5", "ANON", "IDEA"];
const PROBE_TIMEOUT_MS = 8_000;

function finding(score: number, rest: Omit<Finding, "severity" | "cvssScore">): Finding {
  return { ...rest, severity: severityFromScore(score), cvssScore: score };
}

interface TlsInfo {
  protocol: string;
  cipher: string;
  notAfter: Date | undefined;
}

function probeTls(hostname: string, port: number): Promise<TlsInfo | undefined> {
  return new Promise((resolve) => {
    const socket = tls.connect(
      { host: hostname, port, servername: hostname, timeout: PROBE_TIMEOUT_MS, rejectUnauthorized: false },
      () => {
        const cert = socket.getPeerCertificate();
        const cipher = socket.getCipher();
        const protocol = socket.getProtocol();
        socket.end();
        resolve({
          protocol: protocol || "unknown",
          cipher: cipher?.name ?? "unknown",
          notAfter: cert?.valid_to ? new Date(cert.valid_to) : undefined,
        });
      },
    );
    socket.on("timeout", () => {
      socket.destroy();
      resolve(undefined);
    });
    socket.on("error", () => resolve(undefined));
  });
}

function checkExpiry(notAfter: Date | undefined, target: string): Finding | undefined {
  if (!notAfter) return undefined;
  const daysLeft = Math.floor((notAfter.getTime() - Date.now()) / (1000 * 60 * 60 * 24));

  let score: number;
  let title: string;
  if (daysLeft < 0) {
    score = 7.5;
    title = "TLS Certificate Expired";
  } else if (daysLeft <= EXPIRY_WARNING_DAYS) {
    score = 4.3;
    title = "TLS Certificate Expiring Soon";
  } else {
    return undefined;
  }

  return finding(score, {
    id: "tls-certificate-expiry",
    title,
    cvssVector: daysLeft >= 0 ? "AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:L" : "AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:L/A:N",
    cwe: "CWE-298",
    description: `The TLS certificate ${daysLeft < 0 ? "has expired" : "expires soon"} (notAfter=${notAfter.toISOString()}).`,
    evidence: `Certificate notAfter: ${notAfter.toISOString()} (${daysLeft} days from now)`,
    impact:
      "An expired certificate breaks TLS trust and browser warnings may train users to click through security prompts; upcoming expiry risks an unplanned outage.",
    remediation: "Renew the certificate and automate renewal (e.g. via ACME/Let's Encrypt) well ahead of expiry.",
    affectedEndpoint: target,
  });
}

/**
 * Flags the negotiated cipher if its name matches a known-weak algorithm.
 * This only inspects what a *modern* default TLS client actually
 * negotiated — it doesn't attempt to force a weak cipher to test whether
 * the server would still accept one from a legacy client (current
 * OpenSSL/Node builds have dropped RC4/DES/3DES entirely, so this
 * environment can't even offer them in a ClientHello). Best-effort: fires
 * only against a server so misconfigured it steers even a modern client
 * onto a weak cipher.
 */
function checkWeakCipher(cipherName: string, target: string): Finding | undefined {
  const upper = cipherName.toUpperCase();
  const marker = WEAK_CIPHER_MARKERS.find((m) => upper.includes(m));
  if (!marker) return undefined;

  return finding(7.4, {
    id: "tls-weak-cipher",
    title: `Weak TLS Cipher Negotiated (${cipherName})`,
    cvssVector: "AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:L/A:N",
    cwe: "CWE-327",
    description: `The server negotiated ${cipherName}, which contains the known-weak marker '${marker}'.`,
    evidence: `Negotiated cipher: ${cipherName}`,
    impact: "Weak ciphers are vulnerable to known cryptographic attacks that can recover plaintext or forge traffic.",
    remediation: "Configure the server's cipher suite list to only offer strong, modern ciphers (AEAD suites such as AES-GCM/ChaCha20-Poly1305) and disable legacy ones.",
    affectedEndpoint: target,
  });
}

async function scanTls(target: string): Promise<ScanOutput> {
  const findings: Finding[] = [];
  const passed: PassedControl[] = [];

  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    throw new Error(`"${target}" is not a valid URL.`);
  }

  if (parsed.protocol !== "https:") {
    if (parsed.protocol === "http:") {
      findings.push(
        finding(7.4, {
          id: "tls-plaintext-http",
          title: "Target Served Over Plaintext HTTP",
          cvssVector: "AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:L/A:N",
          cwe: "CWE-319",
          description: "The target is reachable over unencrypted HTTP.",
          evidence: `Target URL scheme is 'http': ${target}`,
          impact: "Traffic (including credentials/session tokens) can be intercepted or modified in transit by a network attacker.",
          remediation: "Serve the application exclusively over HTTPS and redirect all HTTP traffic to HTTPS.",
          affectedEndpoint: target,
        }),
      );
    }
    return { findings, passedControls: passed };
  }

  const port = parsed.port ? Number(parsed.port) : 443;
  const info = await probeTls(parsed.hostname, port);
  if (!info) return { findings, passedControls: passed };

  if (WEAK_PROTOCOLS.has(info.protocol)) {
    findings.push(
      finding(7.4, {
        id: "tls-weak-protocol",
        title: `Weak TLS Protocol Negotiated (${info.protocol})`,
        cvssVector: "AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:L/A:N",
        cwe: "CWE-327",
        description: `The server negotiated ${info.protocol}, which is considered cryptographically weak or deprecated.`,
        evidence: `Negotiated protocol: ${info.protocol}`,
        impact: "Deprecated protocols are vulnerable to known downgrade and cryptographic attacks (e.g. POODLE, BEAST).",
        remediation: "Disable all protocol versions below TLS 1.2 and prefer TLS 1.3.",
        affectedEndpoint: target,
      }),
    );
  } else {
    passed.push({ label: "TLS protocol", detail: `${info.protocol}, cipher ${info.cipher}.` });
  }

  const expiryFinding = checkExpiry(info.notAfter, target);
  if (expiryFinding) findings.push(expiryFinding);
  else if (info.notAfter) passed.push({ label: "Certificate validity", detail: `Certificate valid until ${info.notAfter.toISOString()}.` });

  const cipherFinding = checkWeakCipher(info.cipher, target);
  if (cipherFinding) findings.push(cipherFinding);
  else passed.push({ label: "TLS cipher strength", detail: `Negotiated cipher ${info.cipher} does not match any known-weak cipher marker.` });

  return { findings, passedControls: passed };
}

interface SecurityScanTlsInput {
  url: string;
}

export const securityScanTlsTool: ToolDefinition<SecurityScanTlsInput> = {
  name: "security_scan_tls",
  description:
    "Security tool. Check a target's TLS configuration — protocol version, negotiated cipher, and certificate " +
    "expiry — a direct port of the user's own cyberlens scanner's TLS check. Flags plaintext HTTP, deprecated " +
    "protocols (SSLv2/3, TLS 1.0/1.1), known-weak ciphers, and an expired/soon-to-expire certificate. " +
    "IMPORTANT: only scan a target the user owns or has explicit, documented authorization to test.",
  riskLevel: "ask",
  inputSchema: {
    type: "object",
    properties: { url: { type: "string", description: "Target URL, e.g. https://example.com" } },
    required: ["url"],
  },
  describeCall: (input) => `scan TLS config: ${input.url}`,
  async handler(input) {
    try {
      const output = await scanTls(input.url);
      return { content: formatScanOutput(input.url, output), isError: false };
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), isError: true };
    }
  },
};
