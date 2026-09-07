import { randomUUID } from "node:crypto";
import { chromium } from "playwright-core";
import type { ToolDefinition } from "../../../core/types.js";
import { severityFromScore } from "./cvss.js";
import { mask } from "./patterns.js";
import { formatScanOutput, type Finding, type PassedControl, type ScanOutput } from "./types.js";

// Port of cyberlens's account_creation.py, given the registration page's
// URL directly rather than discovered via a crawl (no crawler in this
// project — the caller already knows which page has the registration
// form, since they're pointing this tool at it). Fields are found by
// querying the rendered DOM directly (input/select/textarea) instead of
// a pre-discovered form model, but the fill/submit/success-detection
// logic is otherwise a faithful port of form_interaction.py.
//
// Scope is deliberately narrow, same as the original: does NOT log in
// afterward, does NOT explore the authenticated application, and makes
// AT MOST ONE registration attempt — creating a real account on a real
// target has real consequences (an actual account now exists; many ToS
// explicitly prohibit automated signups even when the site owner
// authorized this scan). riskLevel "dangerous", same tier as the
// exploit-payload tools, arguably more consequential since it's a real,
// hard-to-undo state change rather than a read.
//
// The submitted email always uses the example.com domain (RFC 2606,
// reserved for documentation/testing, guaranteed to never deliver mail to
// a real inbox).
const NAV_TIMEOUT_MS = 25_000;
const ACTION_TIMEOUT_MS = 3_000;
const SUBMIT_SETTLE_TIMEOUT_MS = 5_000;

const SUBMIT_TEXT_MARKERS = [
  "s'inscrire", "sinscrire", "inscription", "s'enregistrer", "creer mon compte", "créer mon compte",
  "create account", "sign up", "signup", "register", "se connecter", "connexion", "log in", "login",
  "sign in", "signin", "submit", "envoyer", "valider", "continue", "continuer",
];
const CAPTCHA_MARKERS = ["g-recaptcha", "grecaptcha", "recaptcha", "h-captcha", "hcaptcha", "cf-turnstile", "turnstile", "captcha"];
const ERROR_MARKERS = [
  "already exists", "already registered", "already taken", "already in use", "invalid email", "invalid password",
  "error", "erreur", "déjà utilisé", "déjà inscrit", "required", "requis",
];
const SUCCESS_MARKERS = [
  "welcome", "bienvenue", "account created", "compte créé", "verify your email", "vérifiez votre e-mail",
  "check your inbox", "confirmez votre inscription", "registration successful", "inscription réussie",
];

function matchesSubmitKeyword(text: string): boolean {
  const lowered = text.trim().toLowerCase();
  return SUBMIT_TEXT_MARKERS.some((marker) => lowered.includes(marker));
}

async function findSubmitControl(page: import("playwright-core").Page) {
  for (const selector of ['button[type="submit"]', 'input[type="submit"]']) {
    const locator = page.locator(selector).first();
    if ((await locator.count()) > 0) return locator;
  }

  const buttons = page.locator('button, input[type="button"], [role="button"]');
  const count = await buttons.count();
  for (let i = 0; i < count; i++) {
    const candidate = buttons.nth(i);
    let text = "";
    try {
      text = await candidate.innerText();
    } catch {
      // keep empty text
    }
    if (matchesSubmitKeyword(text)) return candidate;
  }
  return count > 0 ? buttons.nth(count - 1) : undefined;
}

export function syntheticValue(name: string, fieldType: string, runId: string): string {
  const loweredName = name.toLowerCase();
  const loweredType = fieldType.toLowerCase();

  if (loweredType === "email" || loweredName.includes("email") || loweredName.includes("e-mail")) return `finanfa-test-${runId}@example.com`;
  if (loweredType === "password" || loweredName.includes("pass")) return "FinanfaCode-Test-9f3a!";
  if (loweredType === "checkbox" || loweredType === "radio") return "on";
  if (loweredName.includes("phone") || loweredName.includes("tel")) return "0000000000";
  if (loweredName.includes("user") && !loweredName.includes("pass")) return `finanfa_test_${runId}`;
  if (loweredName.includes("name")) return "FinanfaCode Test User";
  return "test";
}

function looksSuccessful(finalHtml: string, finalUrl: string, originalUrl: string): boolean {
  const body = finalHtml.toLowerCase();
  if (ERROR_MARKERS.some((marker) => body.includes(marker))) return false;
  if (finalUrl !== originalUrl) return true;
  return SUCCESS_MARKERS.some((marker) => body.includes(marker));
}

function hasCaptchaMarkers(html: string): boolean {
  const lowered = html.toLowerCase();
  return CAPTCHA_MARKERS.some((marker) => lowered.includes(marker));
}

async function attemptRegistration(pageUrl: string): Promise<{ finding?: Finding; passed: PassedControl }> {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (err) {
    return { passed: { label: "Account creation attempt skipped (no browser available)", detail: `No Playwright browser could be launched: ${err instanceof Error ? err.message : String(err)}` } };
  }

  try {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    try {
      const page = await context.newPage();
      await page.goto(pageUrl, { timeout: NAV_TIMEOUT_MS, waitUntil: "load" });

      if (hasCaptchaMarkers(await page.content())) {
        return {
          passed: {
            label: "CAPTCHA protection present on registration form",
            detail: `The registration form at ${pageUrl} includes a CAPTCHA widget; no account-creation attempt was made (submitting to a CAPTCHA-protected form would not succeed and risks tripping abuse detection).`,
          },
        };
      }

      const runId = randomUUID().replace(/-/g, "").slice(0, 10);
      const fields = page.locator("input, select, textarea");
      const fieldCount = await fields.count();
      const filledFields: Record<string, string> = {};

      for (let i = 0; i < fieldCount; i++) {
        const field = fields.nth(i);
        const name = (await field.getAttribute("name")) ?? (await field.getAttribute("id")) ?? "";
        if (!name) continue;
        const type = (await field.getAttribute("type")) ?? "text";
        if (type === "hidden" || type === "submit" || type === "button") continue;
        try {
          const value = syntheticValue(name, type, runId);
          if (type === "checkbox" || type === "radio") await field.check({ timeout: ACTION_TIMEOUT_MS });
          else await field.fill(value, { timeout: ACTION_TIMEOUT_MS });
          filledFields[name] = value;
        } catch {
          continue;
        }
      }

      if (Object.keys(filledFields).length === 0) {
        return {
          passed: { label: "Account creation attempt did not appear to succeed", detail: `None of the ${fieldCount} detected field(s) on ${pageUrl} could be filled in (selectors did not match the rendered page).` },
        };
      }

      const submit = await findSubmitControl(page);
      if (!submit) {
        return { passed: { label: "Account creation attempt did not appear to succeed", detail: `No submit-like button was found on ${pageUrl}.` } };
      }

      const capturedRequests: string[] = [];
      page.on("request", (req) => {
        if (["POST", "PUT", "PATCH"].includes(req.method())) capturedRequests.push(`${req.method()} ${req.url()}`);
      });

      const originalUrl = page.url();
      try {
        await submit.click({ timeout: ACTION_TIMEOUT_MS });
      } catch {
        // still check the outcome below — a click that "fails" (e.g. detached after navigation) may have still submitted.
      }
      try {
        await page.waitForLoadState("networkidle", { timeout: SUBMIT_SETTLE_TIMEOUT_MS });
      } catch {
        // best-effort settle wait
      }

      const finalHtml = await page.content();
      const finalUrl = page.url();
      const requestNote = capturedRequests.length > 0 ? ` Observed request(s): ${capturedRequests.slice(0, 3).join(", ")}.` : "";

      if (!looksSuccessful(finalHtml, finalUrl, originalUrl)) {
        return {
          passed: { label: "Account creation attempt did not appear to succeed", detail: `Filled in and submitted the form at ${pageUrl}; the result did not match success indicators.${requestNote}` },
        };
      }

      const score = 5.3;
      const submittedSummary = Object.entries(filledFields)
        .map(([name, value]) => `${name}=${name.toLowerCase().includes("password") ? mask(value) : value}`)
        .join(", ");
      return {
        finding: {
          id: "account-creation-no-bot-protection",
          title: "Account Creation Succeeded Without CAPTCHA/Bot Protection (Needs Manual Verification)",
          severity: severityFromScore(score),
          cvssVector: "AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:L/A:N",
          cvssScore: score,
          cwe: "CWE-799",
          description: `Filling in and submitting the registration form at ${pageUrl} like a human would produced a result that looks like a successful account creation, with no CAPTCHA or other bot-protection challenge encountered beforehand.`,
          evidence: `Filled (${submittedSummary}) on ${pageUrl}, clicked the submit control -> landed on ${finalUrl}.${requestNote}`,
          impact:
            "Without a CAPTCHA or equivalent rate-limiting/anti-automation control, an attacker can script mass account creation — for spam, fake reviews/engagement, credential-stuffing infrastructure, or exhausting resources tied to each account (free trial abuse, storage quotas).",
          remediation:
            "Add a CAPTCHA (or equivalent proof-of-work/behavioral check) and/or per-IP rate limiting to the registration endpoint. This finding is heuristic — manually verify a real account was actually created before prioritizing remediation.",
          affectedEndpoint: pageUrl,
        },
        passed: { label: "", detail: "" },
      };
    } finally {
      await context.close();
    }
  } catch (err) {
    return { passed: { label: "Account creation attempt failed", detail: `Interacting with ${pageUrl} raised an unexpected error: ${err instanceof Error ? err.message : String(err)}` } };
  } finally {
    await browser.close();
  }
}

interface SecurityScanAccountCreationInput {
  url: string;
}

export const securityScanAccountCreationTool: ToolDefinition<SecurityScanAccountCreationInput> = {
  name: "security_scan_account_creation",
  description:
    "Security tool. WARNING: this creates a REAL account on the target if the registration form has no bot " +
    "protection — a real, hard-to-undo state change, not a read-only check. Navigates to a given registration " +
    "page in a real headless Chromium, fills in its fields like a human would (submitted email always uses " +
    "the example.com domain, RFC 2606-reserved, never delivers real mail), clicks the submit control, and " +
    "flags whether it succeeded with no CAPTCHA/bot-protection challenge. Makes AT MOST ONE attempt on the " +
    "ONE given page — never explores further, never logs in afterward. A port of the user's own cyberlens " +
    "scanner's account_creation check, pointed directly at the registration page URL (no crawler here to " +
    "discover which page has one — you must already know it). " +
    "IMPORTANT: only use this against a target you own or have explicit, documented authorization to test — " +
    "many Terms of Service explicitly prohibit automated signups even on an authorized target. Confirm with " +
    "the user before running this specific tool, given it creates real, persistent state.",
  riskLevel: "dangerous",
  inputSchema: {
    type: "object",
    properties: { url: { type: "string", description: "URL of the registration/signup page to test" } },
    required: ["url"],
  },
  describeCall: (input) => `attempt account creation (real, state-changing) on: ${input.url}`,
  async handler(input) {
    try {
      new URL(input.url);
    } catch {
      return { content: `"${input.url}" is not a valid URL.`, isError: true };
    }
    const { finding, passed } = await attemptRegistration(input.url);
    const output: ScanOutput = finding ? { findings: [finding], passedControls: [] } : { findings: [], passedControls: [passed] };
    return { content: formatScanOutput(input.url, output), isError: false };
  },
};
