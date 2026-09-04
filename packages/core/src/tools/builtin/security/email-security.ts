import { resolveTxt } from "node:dns/promises";
import type { ToolDefinition } from "../../../core/types.js";
import { severityFromScore } from "./cvss.js";
import { formatScanOutput, type Finding, type PassedControl, type ScanOutput } from "./types.js";

// Direct port of cyberlens's email_security.py — SPF, DMARC, and
// best-effort DKIM via a handful of commonly-guessed selector names (DKIM
// selectors aren't enumerable via DNS alone, so a miss is informational,
// not a confirmed absence — same as the original).
const COMMON_DKIM_SELECTORS = ["default", "google", "selector1", "selector2", "k1", "dkim", "mail", "smtp", "s1", "s2"];
const DNS_TIMEOUT_MS = 5_000;

function finding(score: number, rest: Omit<Finding, "severity" | "cvssScore">): Finding {
  return { ...rest, severity: severityFromScore(score), cvssScore: score };
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms));
  return Promise.race([promise, timeout]);
}

async function queryTxt(name: string): Promise<string[]> {
  try {
    const records = await withTimeout(resolveTxt(name), DNS_TIMEOUT_MS);
    return records.map((parts) => parts.join(""));
  } catch {
    return [];
  }
}

function dmarcTag(record: string, tag: string): string | undefined {
  for (const rawPart of record.split(";")) {
    const part = rawPart.trim();
    if (part.toLowerCase().startsWith(`${tag}=`)) return part.split("=", 2)[1]?.trim().toLowerCase();
  }
  return undefined;
}

async function checkSpf(domain: string, findings: Finding[], passed: PassedControl[]): Promise<void> {
  const records = await queryTxt(domain);
  const spfRecords = records.filter((r) => r.toLowerCase().startsWith("v=spf1"));

  if (spfRecords.length === 0) {
    findings.push(
      finding(5.3, {
        id: "email-missing-spf",
        title: "Missing SPF Record",
        cvssVector: "AV:N/AC:L/PR:N/UI:R/S:U/C:N/I:H/A:N",
        cwe: "CWE-290",
        description: `No SPF (v=spf1) TXT record was found for ${domain}.`,
        evidence: `TXT records for ${domain}: ${records.length > 0 ? records.join(", ") : "(none)"}`,
        impact: `Without SPF, receiving mail servers cannot verify that email claiming to be from ${domain} was sent from an authorized server, making the domain easier to spoof in phishing campaigns.`,
        remediation: "Publish an SPF TXT record listing authorized mail servers, e.g. v=spf1 include:_spf.example.com ~all.",
        affectedEndpoint: domain,
      }),
    );
    return;
  }

  const spf = spfRecords[0];
  if (spf.trimEnd().endsWith("+all")) {
    findings.push(
      finding(6.5, {
        id: "email-spf-allows-all",
        title: "SPF Record Allows Any Sender (+all)",
        cvssVector: "AV:N/AC:L/PR:N/UI:R/S:U/C:N/I:H/A:N",
        cwe: "CWE-290",
        description: `The SPF record for ${domain} ends in '+all', which permits any server to send mail as this domain.`,
        evidence: `SPF record: ${spf}`,
        impact: "Effectively disables SPF's anti-spoofing protection.",
        remediation: "Replace +all with ~all (soft fail) or -all (hard fail).",
        affectedEndpoint: domain,
      }),
    );
  } else {
    passed.push({ label: "SPF record present", detail: `SPF record: ${spf}` });
  }
}

async function checkDmarc(domain: string, findings: Finding[], passed: PassedControl[]): Promise<void> {
  const records = await queryTxt(`_dmarc.${domain}`);
  const dmarcRecords = records.filter((r) => r.toLowerCase().startsWith("v=dmarc1"));

  if (dmarcRecords.length === 0) {
    findings.push(
      finding(5.3, {
        id: "email-missing-dmarc",
        title: "Missing DMARC Record",
        cvssVector: "AV:N/AC:L/PR:N/UI:R/S:U/C:N/I:H/A:N",
        cwe: "CWE-290",
        description: `No DMARC (v=DMARC1) TXT record was found at _dmarc.${domain}.`,
        evidence: `TXT records for _dmarc.${domain}: ${records.length > 0 ? records.join(", ") : "(none)"}`,
        impact: "Without DMARC, there is no policy telling receiving mail servers what to do with mail that fails SPF/DKIM, and no reporting visibility into spoofing attempts.",
        remediation: `Publish a DMARC record, e.g. v=DMARC1; p=quarantine; rua=mailto:dmarc-reports@${domain}.`,
        affectedEndpoint: domain,
      }),
    );
    return;
  }

  const dmarc = dmarcRecords[0];
  const policy = dmarcTag(dmarc, "p");
  if (policy === "none") {
    findings.push(
      finding(4.3, {
        id: "email-dmarc-policy-none",
        title: "DMARC Policy Set to 'none' (Monitoring Only)",
        cvssVector: "AV:N/AC:L/PR:N/UI:R/S:U/C:N/I:L/A:N",
        cwe: "CWE-290",
        description: `The DMARC policy for ${domain} is p=none, which only requests reporting and does not instruct receivers to quarantine or reject mail that fails SPF/DKIM.`,
        evidence: `DMARC record: ${dmarc}`,
        impact: "Spoofed mail that fails SPF/DKIM is still delivered as normal; p=none provides visibility but no actual enforcement.",
        remediation: "Move to p=quarantine, and eventually p=reject, once DMARC reports confirm legitimate mail flows aren't affected.",
        affectedEndpoint: domain,
      }),
    );
  } else {
    passed.push({ label: "DMARC enforced", detail: `DMARC record: ${dmarc}` });
  }
}

async function checkDkim(domain: string, findings: Finding[], passed: PassedControl[]): Promise<void> {
  for (const selector of COMMON_DKIM_SELECTORS) {
    const records = await queryTxt(`${selector}._domainkey.${domain}`);
    if (records.some((r) => r.includes("p="))) {
      passed.push({ label: "DKIM record found", detail: `Found a DKIM key at selector '${selector}'.` });
      return;
    }
  }

  findings.push({
    id: "email-dkim-not-confirmed",
    title: "DKIM Not Confirmed (Common Selectors Checked)",
    severity: "INFO",
    description: `None of ${COMMON_DKIM_SELECTORS.length} common DKIM selector names resolved for ${domain}.`,
    evidence: `Checked selectors: ${COMMON_DKIM_SELECTORS.join(", ")}`,
    impact:
      "DKIM selectors are provider-specific and not enumerable via DNS, so this does not confirm DKIM is actually absent — only that it isn't using one of the commonly guessed selector names. If DKIM truly isn't configured, receiving servers cannot cryptographically verify message integrity/origin, weakening anti-spoofing defenses alongside SPF/DMARC.",
    remediation: "Confirm with your email provider which DKIM selector(s) are in use and verify the corresponding DNS TXT record is published.",
    affectedEndpoint: domain,
  });
}

async function scanEmailSecurity(targetUrl: string): Promise<ScanOutput> {
  const findings: Finding[] = [];
  const passed: PassedControl[] = [];

  let domain: string;
  try {
    domain = new URL(targetUrl).hostname;
  } catch {
    throw new Error(`"${targetUrl}" is not a valid URL.`);
  }
  if (!domain) throw new Error(`"${targetUrl}" has no hostname.`);

  await checkSpf(domain, findings, passed);
  await checkDmarc(domain, findings, passed);
  await checkDkim(domain, findings, passed);

  return { findings, passedControls: passed };
}

interface SecurityScanEmailSecurityInput {
  url: string;
}

export const securityScanEmailSecurityTool: ToolDefinition<SecurityScanEmailSecurityInput> = {
  name: "security_scan_email_security",
  description:
    "Security tool. Checks a domain's SPF, DMARC, and (best-effort) DKIM DNS records — anti-spoofing controls " +
    "that let receiving mail servers verify email claiming to be from this domain is legitimate. Flags a " +
    "missing SPF/DMARC record, an SPF record ending in '+all' (allows any sender), and a DMARC policy of " +
    "p=none (reporting only, no enforcement). A faithful port of the user's own cyberlens scanner's " +
    "email_security check. " +
    "IMPORTANT: only scan a target the user owns or has explicit, documented authorization to test.",
  riskLevel: "ask",
  inputSchema: {
    type: "object",
    properties: { url: { type: "string", description: "Target URL, e.g. https://example.com — its hostname's email DNS records are checked" } },
    required: ["url"],
  },
  describeCall: (input) => `check email security (SPF/DMARC/DKIM): ${input.url}`,
  async handler(input) {
    try {
      const output = await scanEmailSecurity(input.url);
      return { content: formatScanOutput(input.url, output), isError: false };
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), isError: true };
    }
  },
};
