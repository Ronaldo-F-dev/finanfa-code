import type { ToolDefinition } from "../../../core/types.js";
import { severityFromScore } from "./cvss.js";
import { formatScanOutput, type Finding, type PassedControl, type ScanOutput } from "./types.js";

// Direct port of cyberlens's websocket.py — Socket.IO configuration
// checks: auth-free handshake, CORS wildcard, client-script version
// disclosure. GET-only, safe by default.
const HANDSHAKE_PATH = "/socket.io/?EIO=4&transport=polling";
const CLIENT_SCRIPT_PATH = "/socket.io/socket.io.js";
const VERSION_PATTERN = /Socket\.IO v?(\d+\.\d+\.\d+)/i;
const PROBE_ORIGIN = "https://finanfa-cors-probe.invalid";

function finding(score: number, rest: Omit<Finding, "severity" | "cvssScore">): Finding {
  return { ...rest, severity: severityFromScore(score), cvssScore: score };
}

async function checkClientScript(target: string): Promise<Finding | undefined> {
  const url = new URL(CLIENT_SCRIPT_PATH, target).toString();
  let response: Response;
  try {
    response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(10_000) });
  } catch {
    return undefined;
  }
  if (response.status !== 200) return undefined;

  const body = await response.text();
  const match = VERSION_PATTERN.exec(body);
  const version = match?.[1] ?? "unknown";

  return finding(5.3, {
    id: "websocket-client-script-version-disclosure",
    title: "Socket.IO Client Script Reveals Version",
    cvssVector: "AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:N/A:N",
    cwe: "CWE-200",
    description: `${CLIENT_SCRIPT_PATH} is publicly served and reveals Socket.IO version ${version}.`,
    evidence: `GET ${url} -> HTTP 200, version string '${version}' found in body.`,
    impact: "Lets an attacker search for and target CVEs specific to this exact Socket.IO version.",
    remediation: "Serve the Socket.IO client bundle from a CDN/static asset without a predictable version-revealing path, or restrict access in production.",
    affectedEndpoint: url,
  });
}

async function scanWebsocket(targetUrl: string): Promise<ScanOutput> {
  const findings: Finding[] = [];
  const passed: PassedControl[] = [];

  let target: URL;
  try {
    target = new URL(targetUrl);
  } catch {
    throw new Error(`"${targetUrl}" is not a valid URL.`);
  }

  const handshakeUrl = new URL(HANDSHAKE_PATH, target).toString();
  let response: Response;
  try {
    response = await fetch(handshakeUrl, { headers: { Origin: PROBE_ORIGIN }, redirect: "follow", signal: AbortSignal.timeout(10_000) });
  } catch {
    return { findings: [], passedControls: [{ label: "No Socket.IO server detected", detail: "The handshake endpoint could not be reached." }] };
  }

  const body = await response.text();
  if (response.status !== 200 || !body.includes('"sid"')) {
    return { findings: [], passedControls: [{ label: "No Socket.IO server detected", detail: "The handshake endpoint did not respond with a valid Socket.IO session." }] };
  }

  findings.push(
    finding(6.5, {
      id: "websocket-handshake-no-auth",
      title: "Socket.IO Handshake Accepted Without Authentication",
      cvssVector: "AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:L/A:N",
      cwe: "CWE-306",
      description: "The Socket.IO server issues a valid session id (sid) during handshake without requiring an auth token.",
      evidence: `GET ${handshakeUrl} -> HTTP 200, response contains a 'sid' field.`,
      impact: "Any client can obtain a connected socket session before proving identity, expanding the pre-auth attack surface.",
      remediation: "Validate an auth token in the Socket.IO connection middleware, before the handshake completes.",
      affectedEndpoint: handshakeUrl,
    }),
  );

  const allowOrigin = response.headers.get("access-control-allow-origin");
  if (allowOrigin === "*" || allowOrigin === PROBE_ORIGIN) {
    findings.push(
      finding(6.5, {
        id: "websocket-cors-wildcard",
        title: "Socket.IO CORS Allows Arbitrary Origins",
        cvssVector: "AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:L/A:N",
        cwe: "CWE-942",
        description: "The Socket.IO handshake reflects/wildcards Access-Control-Allow-Origin for an untrusted origin.",
        evidence: `Origin: ${PROBE_ORIGIN} => Access-Control-Allow-Origin: ${allowOrigin}`,
        impact: "A malicious web page can force an authenticated victim's browser to connect to the WebSocket and send events on their behalf.",
        remediation: "Restrict Socket.IO CORS to an explicit allow-list of trusted origins.",
        affectedEndpoint: handshakeUrl,
      }),
    );
  } else {
    passed.push({ label: "Socket.IO CORS", detail: "Handshake does not reflect/wildcard an arbitrary probe origin." });
  }

  const scriptFinding = await checkClientScript(target.toString());
  if (scriptFinding) findings.push(scriptFinding);

  return { findings, passedControls: passed };
}

interface SecurityScanWebsocketInput {
  url: string;
}

export const securityScanWebsocketTool: ToolDefinition<SecurityScanWebsocketInput> = {
  name: "security_scan_websocket",
  description:
    "Security tool. Checks a Socket.IO server's configuration: does the handshake issue a session with no " +
    "auth token required, does its CORS reflect/wildcard an arbitrary origin, and does its client script " +
    "publicly reveal a version string. GET-only, safe to run. A faithful port of the user's own cyberlens " +
    "scanner's websocket check. Reports 'no Socket.IO server detected' plainly rather than guessing when the " +
    "target isn't running one. " +
    "IMPORTANT: only scan a target the user owns or has explicit, documented authorization to test.",
  riskLevel: "ask",
  inputSchema: {
    type: "object",
    properties: { url: { type: "string", description: "Target base URL, e.g. https://example.com" } },
    required: ["url"],
  },
  describeCall: (input) => `check Socket.IO configuration: ${input.url}`,
  async handler(input) {
    try {
      const output = await scanWebsocket(input.url);
      return { content: formatScanOutput(input.url, output), isError: false };
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), isError: true };
    }
  },
};
