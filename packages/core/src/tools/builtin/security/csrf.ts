import { createHash } from "node:crypto";
import type { ToolDefinition } from "../../../core/types.js";
import { severityFromScore } from "./cvss.js";
import { syntheticValue } from "./account-creation.js";
import { formatScanOutput, type Finding, type PassedControl, type ScanOutput } from "./types.js";

// Port of cyberlens's csrf.py. The PASSIVE structural check (does a POST
// form have a field that looks like an anti-CSRF token?) needs no
// requests at all — this tool takes the form's fields directly (the agent
// can get them from read_file or a browser tool) rather than crawling for
// them itself, since this project has no crawler-fed form model.
//
// The ACTIVE confirmation (submit the form twice — once normally, once
// with a forged, foreign Origin/Referer, using an authenticated session —
// to prove the missing token is really exploitable) is now also ported:
// pass optional `headers` (the caller's own authenticated session, same
// pattern as idor.ts/bfla.ts) and `fieldTypes` (so synthetic values can be
// generated per field, same helper as account-creation.ts). If the
// baseline submission doesn't look like a success (status >= 400), the
// active test is inconclusive and this falls back to the passive finding.
const TOKEN_FIELD_MARKERS = ["csrf", "_token", "authenticity_token", "nonce", "xsrf", "requestverificationtoken"];
// RFC 2606 .invalid — guaranteed to never be a real, resolvable domain, so
// there's no ambiguity that this Origin/Referer is genuinely foreign.
const FORGED_ORIGIN = "https://csrf-poc.finanfa-code.invalid";

function hasCsrfToken(fieldNames: string[]): boolean {
  return fieldNames.some((name) => TOKEN_FIELD_MARKERS.some((marker) => name.toLowerCase().includes(marker)));
}

function confirmedFinding(pageUrl: string, formAction: string, baselineStatus: number, forgedStatus: number): Finding {
  const score = 7.1;
  const digest = createHash("sha1").update(`${pageUrl}:${formAction}`).digest("hex").slice(0, 10);
  return {
    id: `csrf-confirmed-${digest}`,
    title: "Cross-Site Request Forgery (CSRF) Confirmed",
    severity: severityFromScore(score),
    cvssVector: "AV:N/AC:L/PR:N/UI:R/S:U/C:N/I:H/A:N",
    cvssScore: score,
    cwe: "CWE-352",
    description: `The POST form at ${pageUrl} (submits to ${formAction}) has no anti-CSRF token, and accepts a submission carrying a forged, foreign Origin/Referer header identically to a normal one — using the authenticated session's own cookies, exactly as a victim's browser would if lured to an attacker's page.`,
    evidence: `Baseline POST -> ${baselineStatus}; forged-Origin POST (Origin: ${FORGED_ORIGIN}) -> ${forgedStatus} (same outcome class).`,
    impact: "An attacker can trick an authenticated, logged-in user into unknowingly submitting this form (e.g. a hidden auto-submitting form on an attacker-controlled page) — the request succeeds using the victim's own session, with no interaction beyond visiting the attacker's page.",
    remediation: "Add a per-session, per-request anti-CSRF token to this form and validate it server-side; also set the session cookie's SameSite attribute to Lax or Strict, and validate the Origin/Referer header as defense in depth.",
    affectedEndpoint: formAction,
  };
}

async function testActive(
  pageUrl: string,
  formAction: string,
  fieldNames: string[],
  fieldTypes: Record<string, string>,
  headers: Record<string, string>,
): Promise<{ finding?: Finding; passed?: PassedControl }> {
  const data = new URLSearchParams();
  for (const name of fieldNames) data.set(name, syntheticValue(name, fieldTypes[name] ?? "text", "csrf-poc"));

  let baseline: Response;
  try {
    baseline = await fetch(formAction, { method: "POST", headers, body: data, signal: AbortSignal.timeout(10_000) });
  } catch {
    return {};
  }
  if (baseline.status >= 400) return {};

  let forged: Response;
  try {
    forged = await fetch(formAction, {
      method: "POST",
      headers: { ...headers, Origin: FORGED_ORIGIN, Referer: `${FORGED_ORIGIN}/` },
      body: data,
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return {};
  }

  if (forged.status < 400) return { finding: confirmedFinding(pageUrl, formAction, baseline.status, forged.status) };

  return {
    passed: {
      label: `CSRF not exploitable on ${formAction}`,
      detail: "Active test: the server accepts a normal submission but rejects an otherwise identical one carrying a forged, foreign Origin/Referer — Origin/Referer validation is evidently enforced server-side despite no token field.",
    },
  };
}

interface SecurityScanCsrfInput {
  pageUrl: string;
  formAction: string;
  fieldNames: string[];
  fieldTypes?: Record<string, string>;
  headers?: Record<string, string>;
}

export const securityScanCsrfTool: ToolDefinition<SecurityScanCsrfInput> = {
  name: "security_scan_csrf",
  description:
    "Security tool. Checks whether a POST form's fields include one that looks like an anti-CSRF token " +
    "(csrf, _token, authenticity_token, nonce, xsrf, RequestVerificationToken) — zero requests sent by default, " +
    "purely structural. Pass the form's page URL, its action URL, and its field names (read the page's HTML " +
    "yourself first, e.g. via read_file or a browser tool, to get these). Without a token field, this is a " +
    "HEURISTIC only, not proof the form is actually forgeable — some apps validate Origin/Referer server-side " +
    "instead. Optionally supply `headers` (an authenticated session's Cookie/Authorization) and `fieldTypes` " +
    "(name -> input type) to ACTIVELY confirm it for real: submits the form once normally, once with a forged, " +
    "foreign Origin/Referer, and checks whether the server accepts both identically. A full port of the user's " +
    "own cyberlens scanner's csrf check. " +
    "IMPORTANT: only use this against a target the user owns or has explicit, documented authorization to test — " +
    "the active mode sends a real, state-changing POST request using the supplied session.",
  riskLevel: "ask",
  inputSchema: {
    type: "object",
    properties: {
      pageUrl: { type: "string", description: "URL of the page containing the form" },
      formAction: { type: "string", description: "The form's action URL (where it submits to)" },
      fieldNames: { type: "array", items: { type: "string" }, description: "Names of every field in the form" },
      fieldTypes: { type: "object", description: "Optional map of field name -> input type (e.g. email, password), used to generate synthetic values for the active test", additionalProperties: { type: "string" } },
      headers: { type: "object", description: "Optional authenticated session headers (e.g. Cookie) to actively confirm exploitability by submitting the form twice", additionalProperties: { type: "string" } },
    },
    required: ["pageUrl", "formAction", "fieldNames"],
  },
  describeCall: (input) => `check CSRF protection: form at ${input.pageUrl} -> ${input.formAction}`,
  async handler(input) {
    if (input.fieldNames.length === 0) {
      const output: ScanOutput = { findings: [], passedControls: [{ label: "No fields given", detail: "No form fields were provided to check." }] };
      return { content: formatScanOutput(input.pageUrl, output), isError: false };
    }

    if (hasCsrfToken(input.fieldNames)) {
      const output: ScanOutput = {
        findings: [],
        passedControls: [{ label: "CSRF token present", detail: `The form includes a field that looks like an anti-CSRF token: ${input.fieldNames.join(", ")}` }],
      };
      return { content: formatScanOutput(input.pageUrl, output), isError: false };
    }

    if (input.headers) {
      const { finding, passed } = await testActive(input.pageUrl, input.formAction, input.fieldNames, input.fieldTypes ?? {}, input.headers);
      if (finding) return { content: formatScanOutput(input.pageUrl, { findings: [finding], passedControls: [] }), isError: false };
      if (passed) return { content: formatScanOutput(input.pageUrl, { findings: [], passedControls: [passed] }), isError: false };
      // inconclusive (request failed, or baseline itself didn't look like success) — fall through to the passive finding
    }

    const score = 5.4;
    const digest = createHash("sha1").update(`${input.pageUrl}:${input.formAction}`).digest("hex").slice(0, 10);
    const finding: Finding = {
      id: `csrf-missing-token-${digest}`,
      title: "Form Missing CSRF Token (Needs Manual Verification)",
      severity: severityFromScore(score),
      cvssVector: "AV:N/AC:L/PR:N/UI:R/S:U/C:N/I:L/A:N",
      cvssScore: score,
      cwe: "CWE-352",
      description: `A POST form at ${input.pageUrl} (submits to ${input.formAction}) has no field that looks like an anti-CSRF token.`,
      evidence: `Form fields: ${input.fieldNames.join(", ")}`,
      impact:
        "Without a per-session CSRF token, an attacker may be able to trick an authenticated user's browser into submitting this form unintentionally (e.g. via a hidden auto-submitting form on an attacker-controlled page). Heuristic: pass `headers` to confirm this for real instead of just inferring it from the missing field.",
      remediation: "Add a per-session, per-request anti-CSRF token to this form and validate it server-side; also set the session cookie's SameSite attribute to Lax or Strict as defense in depth.",
      affectedEndpoint: input.formAction,
    };

    const output: ScanOutput = { findings: [finding], passedControls: [] };
    return { content: formatScanOutput(input.pageUrl, output), isError: false };
  },
};
