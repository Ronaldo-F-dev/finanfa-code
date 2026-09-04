import type { Severity } from "./cvss.js";

export interface Finding {
  id: string;
  title: string;
  severity: Severity;
  cvssVector?: string;
  cvssScore?: number;
  cwe?: string;
  description: string;
  evidence?: string;
  impact?: string;
  remediation?: string;
  affectedEndpoint?: string;
}

export interface PassedControl {
  label: string;
  detail: string;
}

export interface ScanOutput {
  findings: Finding[];
  passedControls: PassedControl[];
}

const SEVERITY_ORDER: Record<Severity, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, INFO: 4 };

/**
 * Renders a scan's findings/passed controls as text for the model — every
 * security_scan_* tool shares this so results read consistently regardless
 * of which check produced them. Sorted worst-first, since that's what a
 * human skimming the output cares about most.
 */
export function formatScanOutput(target: string, output: ScanOutput): string {
  const findings = [...output.findings].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

  if (findings.length === 0 && output.passedControls.length === 0) {
    return `No findings and nothing to report for ${target}.`;
  }

  const lines: string[] = [];
  if (findings.length > 0) {
    lines.push(`${findings.length} finding(s) for ${target}:`);
    for (const f of findings) {
      lines.push("");
      lines.push(`[${f.severity}] ${f.title}${f.cwe ? ` (${f.cwe})` : ""}${f.cvssScore !== undefined ? ` — CVSS ${f.cvssScore}` : ""}`);
      lines.push(f.description);
      if (f.evidence) lines.push(`Evidence: ${f.evidence}`);
      if (f.impact) lines.push(`Impact: ${f.impact}`);
      if (f.remediation) lines.push(`Remediation: ${f.remediation}`);
    }
  } else {
    lines.push(`No findings for ${target}.`);
  }

  if (output.passedControls.length > 0) {
    lines.push("");
    lines.push("Passed controls:");
    for (const p of output.passedControls) lines.push(`- ${p.label}: ${p.detail}`);
  }

  return lines.join("\n");
}
