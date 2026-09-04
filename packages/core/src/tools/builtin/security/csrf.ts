import { createHash } from "node:crypto";
import type { ToolDefinition } from "../../../core/types.js";
import { severityFromScore } from "./cvss.js";
import { formatScanOutput, type Finding, type ScanOutput } from "./types.js";

// Partial port of cyberlens's csrf.py — the PASSIVE structural check only
// (does a POST form have a field that looks like an anti-CSRF token?).
// cyberlens's own active confirmation (submit the form twice — once
// normally, once with a forged Origin/Referer — using an authenticated
// session, to prove the missing token is really exploitable) needs a
// crawler to discover forms and a login/session-management flow neither
// of which exist in this project; that part isn't ported. This tool takes
// the form's fields directly (the agent can get them from read_file or a
// browser tool) rather than crawling for them itself.
const TOKEN_FIELD_MARKERS = ["csrf", "_token", "authenticity_token", "nonce", "xsrf", "requestverificationtoken"];

function hasCsrfToken(fieldNames: string[]): boolean {
  return fieldNames.some((name) => TOKEN_FIELD_MARKERS.some((marker) => name.toLowerCase().includes(marker)));
}

interface SecurityScanCsrfInput {
  pageUrl: string;
  formAction: string;
  fieldNames: string[];
}

export const securityScanCsrfTool: ToolDefinition<SecurityScanCsrfInput> = {
  name: "security_scan_csrf",
  description:
    "Security tool. Checks whether a POST form's fields include one that looks like an anti-CSRF token " +
    "(csrf, _token, authenticity_token, nonce, xsrf, RequestVerificationToken) — zero requests sent, purely " +
    "structural. Pass the form's page URL, its action URL, and its field names (read the page's HTML yourself " +
    "first, e.g. via read_file or a browser tool, to get these). This is a HEURISTIC only, not proof the form " +
    "is actually forgeable — some apps validate Origin/Referer server-side instead of a token field, which this " +
    "can't see either way; say so when reporting a finding from this tool. A PARTIAL port of the user's own " +
    "cyberlens scanner's csrf check — its active double-submission confirmation (with a real authenticated " +
    "session) isn't included here, since this project has no crawler or session/login management. " +
    "IMPORTANT: only use this against a target the user owns or has explicit, documented authorization to test.",
  riskLevel: "ask",
  inputSchema: {
    type: "object",
    properties: {
      pageUrl: { type: "string", description: "URL of the page containing the form" },
      formAction: { type: "string", description: "The form's action URL (where it submits to)" },
      fieldNames: { type: "array", items: { type: "string" }, description: "Names of every field in the form" },
    },
    required: ["pageUrl", "formAction", "fieldNames"],
  },
  describeCall: (input) => `check CSRF protection: form at ${input.pageUrl} -> ${input.formAction}`,
  handler(input) {
    if (input.fieldNames.length === 0) {
      const output: ScanOutput = { findings: [], passedControls: [{ label: "No fields given", detail: "No form fields were provided to check." }] };
      return Promise.resolve({ content: formatScanOutput(input.pageUrl, output), isError: false });
    }

    if (hasCsrfToken(input.fieldNames)) {
      const output: ScanOutput = {
        findings: [],
        passedControls: [{ label: "CSRF token present", detail: `The form includes a field that looks like an anti-CSRF token: ${input.fieldNames.join(", ")}` }],
      };
      return Promise.resolve({ content: formatScanOutput(input.pageUrl, output), isError: false });
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
        "Without a per-session CSRF token, an attacker may be able to trick an authenticated user's browser into submitting this form unintentionally (e.g. via a hidden auto-submitting form on an attacker-controlled page). Heuristic: this doesn't confirm the form actually lacks Origin/Referer validation as an alternative defense.",
      remediation: "Add a per-session, per-request anti-CSRF token to this form and validate it server-side; also set the session cookie's SameSite attribute to Lax or Strict as defense in depth.",
      affectedEndpoint: input.formAction,
    };

    const output: ScanOutput = { findings: [finding], passedControls: [] };
    return Promise.resolve({ content: formatScanOutput(input.pageUrl, output), isError: false });
  },
};
