import { createHash } from "node:crypto";
import type { ToolDefinition } from "../../../core/types.js";
import { severityFromScore } from "./cvss.js";
import { formatScanOutput, type Finding, type PassedControl, type ScanOutput } from "./types.js";

// Port of cyberlens's idor.py, given one URL directly rather than
// discovered via an authenticated crawl (no crawler or session/login
// management exists in this project). Instead of `ctx.authenticated` +
// `ctx.client` carrying pre-established session cookies, this tool takes
// optional `headers` directly — the caller's own session (a cookie or
// Authorization header they already have), representing the same "my
// session" the original scanner's ctx.client held. Both original checks
// still apply and mean the same thing:
//   1. Substituting a neighboring numeric ID with the SAME headers: does a
//      different, valid-looking resource come back? (CWE-639, IDOR)
//   2. The SAME URL with NO headers at all: does it return identical
//      content to the authenticated request? (CWE-306, missing auth)
// GET-only, deliberately skips UUID-keyed resources (no meaningful
// "neighboring ID" to guess).
const ID_SEGMENT_PATTERN = /\/(\d{1,10})(?=\/|$|\?)/g;
const MIN_BODY_BYTES = 40;

function findLastIdSegment(url: string): { start: number; end: number; value: string } | undefined {
  let last: RegExpExecArray | undefined;
  for (const match of url.matchAll(ID_SEGMENT_PATTERN)) last = match;
  if (!last) return undefined;
  return { start: last.index + 1, end: last.index + 1 + last[1].length, value: last[1] };
}

function neighboringId(originalId: string): string {
  const value = Number(originalId);
  return value > 1 ? String(value - 1) : String(value + 1);
}

async function getBytes(url: string, headers?: Record<string, string>): Promise<{ status: number; body: ArrayBuffer } | undefined> {
  try {
    const response = await fetch(url, { headers, redirect: "follow", signal: AbortSignal.timeout(10_000) });
    return { status: response.status, body: await response.arrayBuffer() };
  } catch {
    return undefined;
  }
}

function bytesEqual(a: ArrayBuffer, b: ArrayBuffer): boolean {
  if (a.byteLength !== b.byteLength) return false;
  return Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
}

async function testSequentialId(url: string, headers: Record<string, string>, own: { status: number; body: ArrayBuffer }, idSegment: { start: number; end: number; value: string }): Promise<{ finding?: Finding; passed?: PassedControl }> {
  const neighborId = neighboringId(idSegment.value);
  const neighborUrl = url.slice(0, idSegment.start) + neighborId + url.slice(idSegment.end);

  const neighbor = await getBytes(neighborUrl, headers);
  if (!neighbor) {
    return { passed: { label: `IDOR test inconclusive on ${new URL(url).pathname}`, detail: `The neighboring-ID request (${neighborUrl}) failed to complete.` } };
  }

  if (neighbor.status === 200 && neighbor.body.byteLength >= MIN_BODY_BYTES && !bytesEqual(neighbor.body, own.body)) {
    const score = 7.1;
    return {
      finding: {
        id: `idor-sequential-id-${createHash("sha1").update(`${url}:${neighborUrl}`).digest("hex").slice(0, 10)}`,
        title: "Possible Insecure Direct Object Reference (IDOR)",
        severity: severityFromScore(score),
        cvssVector: "AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:N/A:N",
        cvssScore: score,
        cwe: "CWE-639",
        description: `Using the same session that successfully fetched ${url}, substituting its resource ID (${idSegment.value} -> ${neighborId}) also returned a distinct, seemingly valid response.`,
        evidence: `GET ${url} -> ${own.status} (${own.body.byteLength} bytes); GET ${neighborUrl} -> ${neighbor.status} (${neighbor.body.byteLength} bytes, different content)`,
        impact:
          "An authenticated user may be able to read (and, if the endpoint also accepts writes, modify) other users' resources simply by changing an ID in the request — a broken access control failure. This is heuristic: manually confirm the response actually belongs to a different user/record before prioritizing remediation.",
        remediation: "Verify server-side, on every request, that the authenticated user actually owns or is authorized to access the specific resource ID requested — never rely on an ID being hard to guess as an access control.",
        affectedEndpoint: url,
      },
    };
  }

  return { passed: { label: `No IDOR confirmed on ${new URL(url).pathname}`, detail: `Substituting the resource ID (${idSegment.value} -> ${neighborId}) did not return a distinct, valid-looking response using the same session.` } };
}

async function testMissingAuth(url: string, own: { status: number; body: ArrayBuffer }): Promise<Finding | undefined> {
  const anon = await getBytes(url); // no headers at all
  if (!anon) return undefined;

  if (anon.status === 200 && anon.body.byteLength >= MIN_BODY_BYTES && bytesEqual(anon.body, own.body)) {
    const score = 8.2;
    return {
      id: `broken-access-control-missing-auth-${createHash("sha1").update(url).digest("hex").slice(0, 10)}`,
      title: "Authenticated Endpoint Reachable Without Authentication",
      severity: severityFromScore(score),
      cvssVector: "AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N",
      cvssScore: score,
      cwe: "CWE-306",
      description: `${url} returned identical content with no session/headers at all as it did with the provided session.`,
      evidence: `Authenticated GET ${url} -> ${own.status} (${own.body.byteLength} bytes); anonymous GET -> ${anon.status} (identical content)`,
      impact: "Data intended to require a logged-in session is reachable by anyone, with no authentication at all.",
      remediation: "Require and verify a valid authenticated session on this endpoint before returning any data.",
      affectedEndpoint: url,
    };
  }
  return undefined;
}

async function scanIdor(targetUrl: string, headers?: Record<string, string>): Promise<ScanOutput> {
  let url: URL;
  try {
    url = new URL(targetUrl);
  } catch {
    throw new Error(`"${targetUrl}" is not a valid URL.`);
  }

  if (!headers || Object.keys(headers).length === 0) {
    return {
      findings: [],
      passedControls: [
        { label: "IDOR / broken access control testing not performed", detail: "Requires session headers (e.g. a Cookie or Authorization header) to establish what counts as 'someone else's data' in the first place." },
      ],
    };
  }

  // Matched against the full URL string (not just pathname+search) since
  // testSequentialId's start/end offsets are later used to slice that same
  // full string — matching cyberlens's own regex, which searches the whole
  // URL directly rather than just the path.
  const idSegment = findLastIdSegment(url.toString());
  if (!idSegment) {
    return { findings: [], passedControls: [{ label: "No numeric resource-ID path segment found", detail: "The URL has no purely numeric path segment to substitute a neighboring ID into." }] };
  }

  const own = await getBytes(url.toString(), headers);
  if (!own || own.status !== 200 || own.body.byteLength < MIN_BODY_BYTES) {
    return { findings: [], passedControls: [{ label: "Endpoint not reachable with the given session", detail: `${url.toString()} did not respond successfully with the provided headers.` }] };
  }

  const findings: Finding[] = [];
  const passed: PassedControl[] = [];

  const { finding: idorFinding, passed: idorPassed } = await testSequentialId(url.toString(), headers, own, idSegment);
  if (idorFinding) findings.push(idorFinding);
  else if (idorPassed) passed.push(idorPassed);

  const authFinding = await testMissingAuth(url.toString(), own);
  if (authFinding) findings.push(authFinding);

  return { findings, passedControls: passed };
}

interface SecurityScanIdorInput {
  url: string;
  headers?: Record<string, string>;
}

export const securityScanIdorTool: ToolDefinition<SecurityScanIdorInput> = {
  name: "security_scan_idor",
  description:
    "Security tool. Given a URL with a numeric resource-ID path segment (e.g. /api/orders/42) and your own " +
    "session headers (a Cookie or Authorization header you already have — never guessed or brute-forced), " +
    "checks two things: (1) does substituting a neighboring ID (41 or 43) with the SAME session return a " +
    "distinct, valid-looking response — Insecure Direct Object Reference; (2) does the SAME URL with NO " +
    "headers at all return identical content — the endpoint isn't actually enforcing authentication. GET-only. " +
    "Both findings are heuristic — say so plainly, manual confirmation is needed. A port of the user's own " +
    "cyberlens scanner's idor check, given the URL/session directly rather than discovered via an " +
    "authenticated crawl (no crawler/login flow exists in this project). Without headers, reports that testing " +
    "wasn't performed rather than guessing. " +
    "IMPORTANT: only use this against a target/session you own or have explicit, documented authorization to test.",
  riskLevel: "ask",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "URL with a numeric resource-ID path segment to test" },
      headers: { type: "object", additionalProperties: { type: "string" }, description: "Your own session headers, e.g. { \"Cookie\": \"session=...\" }" },
    },
    required: ["url"],
  },
  describeCall: (input) => `test IDOR / access control: ${input.url}`,
  async handler(input) {
    try {
      const output = await scanIdor(input.url, input.headers);
      return { content: formatScanOutput(input.url, output), isError: false };
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), isError: true };
    }
  },
};
