import { createHmac, timingSafeEqual } from "node:crypto";
import type { ToolDefinition } from "../../../core/types.js";
import { severityFromScore } from "./cvss.js";
import { formatScanOutput, type Finding, type PassedControl, type ScanOutput } from "./types.js";

// Port of cyberlens's jwt_auth.py. JWT parsing/HMAC verification is
// implemented directly against Node's crypto module (base64url decode +
// HMAC-SHA256/384/512) rather than pulling in a JWT library — same
// "well-defined protocol, no dependency needed" approach as this
// project's own CVSS/WHOIS ports; no library is needed to check a
// signature against a short, fixed wordlist. Never attempts credential
// brute force against real accounts — the rate-limit probe below uses an
// obviously fake email/password, checking only whether the endpoint
// throttles a burst at all.
const WEAK_SECRETS = ["secret", "password", "123456", "changeme", "", "jwt_secret"];
const AUTH_PATH_CANDIDATES = ["/api/v1/auth/login", "/auth/login", "/login", "/api/login"];
const BURST_REQUESTS = 15;

function base64UrlDecode(segment: string): Buffer {
  const padded = segment.replace(/-/g, "+").replace(/_/g, "/").padEnd(segment.length + ((4 - (segment.length % 4)) % 4), "=");
  return Buffer.from(padded, "base64");
}

interface JwtParts {
  header: Record<string, unknown>;
  signingInput: string;
  signature: Buffer;
}

function parseJwt(token: string): JwtParts | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const header = JSON.parse(base64UrlDecode(parts[0]).toString("utf-8")) as Record<string, unknown>;
    return { header, signingInput: `${parts[0]}.${parts[1]}`, signature: base64UrlDecode(parts[2]) };
  } catch {
    return undefined;
  }
}

const HS_ALGORITHMS: Record<string, string> = { hs256: "sha256", hs384: "sha384", hs512: "sha512" };

function verifiesWithSecret(jwt: JwtParts, algLower: string, secret: string): boolean {
  const nodeAlgo = HS_ALGORITHMS[algLower];
  if (!nodeAlgo) return false;
  const expected = createHmac(nodeAlgo, secret).update(jwt.signingInput).digest();
  return expected.length === jwt.signature.length && timingSafeEqual(expected, jwt.signature);
}

/** Looks for a JWT already present on the target (e.g. set as a cookie or returned in an Authorization header) — never guesses/forges one. */
async function findSampleJwt(target: string): Promise<string | undefined> {
  let response: Response;
  try {
    response = await fetch(target, { redirect: "follow", signal: AbortSignal.timeout(10_000) });
  } catch {
    return undefined;
  }

  for (const setCookie of response.headers.getSetCookie?.() ?? []) {
    const value = setCookie.split(";")[0]?.split("=", 2)[1];
    if (value && value.split(".").length === 3) return value;
  }

  const authHeader = response.headers.get("authorization") ?? "";
  if (authHeader.toLowerCase().startsWith("bearer ")) return authHeader.slice(7);

  return undefined;
}

function checkJwtWeaknesses(target: string, token: string): { finding?: Finding; passed?: PassedControl } {
  const jwt = parseJwt(token);
  if (!jwt) return {};

  const alg = String(jwt.header.alg ?? "").toLowerCase();
  if (alg === "none") {
    return {
      finding: {
        id: "jwt-alg-none-accepted",
        title: "JWT 'alg: none' Not Rejected",
        severity: severityFromScore(9.1),
        cvssVector: "AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:N",
        cvssScore: 9.1,
        cwe: "CWE-347",
        description: "The observed JWT uses alg:none, meaning tokens are unsigned.",
        evidence: `JWT header: ${JSON.stringify(jwt.header)}`,
        impact: "An attacker can forge arbitrary tokens (including elevated privileges) with no signature at all.",
        remediation: "Reject alg:none explicitly and pin an allow-list of accepted signing algorithms server-side.",
        affectedEndpoint: target,
      },
    };
  }

  let crackedSecret: string | undefined;
  if (alg.startsWith("hs")) {
    for (const candidate of WEAK_SECRETS) {
      if (verifiesWithSecret(jwt, alg, candidate)) {
        crackedSecret = candidate || "<empty string>";
        break;
      }
    }
  }

  if (crackedSecret !== undefined) {
    return {
      finding: {
        id: "jwt-weak-secret",
        title: "JWT Signed With a Weak/Guessable Secret",
        severity: severityFromScore(9.1),
        cvssVector: "AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:N",
        cvssScore: 9.1,
        cwe: "CWE-321",
        description: "The JWT signature validates against a common weak secret.",
        evidence: `Signature verified using guessed secret: ${JSON.stringify(crackedSecret)}`,
        impact: "An attacker can forge valid, signed tokens for any user/role.",
        remediation: "Use a long, randomly generated signing secret (or move to asymmetric signing) stored outside source control.",
        affectedEndpoint: target,
      },
    };
  }

  return { passed: { label: "JWT signing", detail: "alg:none is rejected and the signing secret resists a common weak-secret wordlist." } };
}

async function checkRateLimiting(target: string, path: string): Promise<Finding | PassedControl | undefined> {
  const url = new URL(path, target).toString();
  const requests = Array.from({ length: BURST_REQUESTS }, () =>
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "probe@finanfa-code.invalid", password: "wrong" }),
      signal: AbortSignal.timeout(10_000),
    })
      .then((r) => r.status)
      .catch(() => undefined),
  );
  const statuses = (await Promise.all(requests)).filter((s): s is number => s !== undefined);
  if (statuses.length === 0) return undefined;

  if (statuses.includes(429)) {
    return { label: "Rate limiting", detail: `${path} returned HTTP 429 after a burst of ${BURST_REQUESTS} requests.` };
  }

  return {
    id: "jwt-auth-no-rate-limiting",
    title: "No Rate Limiting on Authentication Endpoint",
    severity: severityFromScore(6.5),
    cvssVector: "AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:L",
    cvssScore: 6.5,
    cwe: "CWE-307",
    description: `${path} accepted ${BURST_REQUESTS} consecutive requests without any HTTP 429/backoff response.`,
    evidence: `POST ${url} x${BURST_REQUESTS} -> statuses observed: ${[...new Set(statuses)].sort().join(", ")}`,
    impact: "Enables credential brute forcing and account enumeration at scale.",
    remediation: "Add per-IP/per-account rate limiting (e.g. token bucket) on authentication endpoints, returning 429 with Retry-After once exceeded.",
    affectedEndpoint: url,
  };
}

function isFinding(x: Finding | PassedControl): x is Finding {
  return "severity" in x;
}

async function scanJwtAuth(targetUrl: string): Promise<ScanOutput> {
  const findings: Finding[] = [];
  const passed: PassedControl[] = [];

  let target: URL;
  try {
    target = new URL(targetUrl);
  } catch {
    throw new Error(`"${targetUrl}" is not a valid URL.`);
  }

  const token = await findSampleJwt(target.toString());
  if (token) {
    const { finding, passed: passedControl } = checkJwtWeaknesses(target.toString(), token);
    if (finding) findings.push(finding);
    else if (passedControl) passed.push(passedControl);
  } else {
    passed.push({ label: "No JWT observed", detail: "No JWT-shaped cookie or Authorization header was present on the target's homepage response." });
  }

  const rateLimitResult = await checkRateLimiting(target.toString(), AUTH_PATH_CANDIDATES[0]);
  if (rateLimitResult) {
    if (isFinding(rateLimitResult)) findings.push(rateLimitResult);
    else passed.push(rateLimitResult);
  }

  return { findings, passedControls: passed };
}

interface SecurityScanJwtAuthInput {
  url: string;
}

export const securityScanJwtAuthTool: ToolDefinition<SecurityScanJwtAuthInput> = {
  name: "security_scan_jwt_auth",
  description:
    "Security tool. Checks a JWT already present on the target (a cookie or Authorization header, e.g. from a " +
    "login response) for alg:none acceptance or a signature that validates against a short common-weak-secret " +
    "wordlist. Also sends a burst of 15 login POST requests with an obviously fake email/password to a common " +
    "auth path (/login, /api/login, ...) to check whether the endpoint rate-limits at all (HTTP 429) — never " +
    "attempts credential brute force against real accounts. A faithful port of the user's own cyberlens " +
    "scanner's jwt_auth check. " +
    "IMPORTANT: only scan a target the user owns or has explicit, documented authorization to test.",
  riskLevel: "ask",
  inputSchema: {
    type: "object",
    properties: { url: { type: "string", description: "Target URL, e.g. https://example.com" } },
    required: ["url"],
  },
  describeCall: (input) => `check JWT/auth rate limiting: ${input.url}`,
  async handler(input) {
    try {
      const output = await scanJwtAuth(input.url);
      return { content: formatScanOutput(input.url, output), isError: false };
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), isError: true };
    }
  },
};
