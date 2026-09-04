// Minimal CVSS v3.1 base-score calculator and severity mapping — a direct
// port of the same logic in cyberlens (core/cvss.py), the user's own
// separate web-security-scanner project, reused here rather than
// reinvented since it's a well-defined public spec (CVSS v3.1) with one
// correct formula. Only the base metric group is implemented (temporal/
// environmental scores need org-specific context an automated scan has no
// insight into).

export type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO";

const WEIGHTS = {
  AV: { N: 0.85, A: 0.62, L: 0.55, P: 0.2 },
  AC: { L: 0.77, H: 0.44 },
  PR_U: { N: 0.85, L: 0.62, H: 0.27 },
  PR_C: { N: 0.85, L: 0.68, H: 0.5 },
  UI: { N: 0.85, R: 0.62 },
  C: { N: 0.0, L: 0.22, H: 0.56 },
  I: { N: 0.0, L: 0.22, H: 0.56 },
  A: { N: 0.0, L: 0.22, H: 0.56 },
} as const;

const VECTOR_PATTERN = /AV:(?<AV>[NALP])\/AC:(?<AC>[LH])\/PR:(?<PR>[NLH])\/UI:(?<UI>[NR])\/S:(?<S>[UC])\/C:(?<C>[NLH])\/I:(?<I>[NLH])\/A:(?<A>[NLH])/;

function roundUpToOneDecimal(value: number): number {
  return Math.ceil(value * 10) / 10;
}

/** Computes the CVSS v3.1 base score from a base metric vector string. Throws on a malformed vector. */
export function scoreFromVector(vector: string): number {
  const match = VECTOR_PATTERN.exec(vector);
  if (!match?.groups) throw new Error(`Invalid CVSS v3.1 base vector: ${vector}`);
  const m = match.groups as Record<"AV" | "AC" | "PR" | "UI" | "S" | "C" | "I" | "A", string>;

  const scopeChanged = m.S === "C";
  const prKey = scopeChanged ? "PR_C" : "PR_U";

  const iss = 1 - (1 - WEIGHTS.C[m.C as keyof typeof WEIGHTS.C]) * (1 - WEIGHTS.I[m.I as keyof typeof WEIGHTS.I]) * (1 - WEIGHTS.A[m.A as keyof typeof WEIGHTS.A]);
  const impact = scopeChanged ? 7.52 * (iss - 0.029) - 3.25 * (iss - 0.02) ** 15 : 6.42 * iss;
  if (impact <= 0) return 0.0;

  const exploitability =
    8.22 *
    WEIGHTS.AV[m.AV as keyof typeof WEIGHTS.AV] *
    WEIGHTS.AC[m.AC as keyof typeof WEIGHTS.AC] *
    WEIGHTS[prKey][m.PR as keyof (typeof WEIGHTS)["PR_U"]] *
    WEIGHTS.UI[m.UI as keyof typeof WEIGHTS.UI];

  const base = scopeChanged ? Math.min(1.08 * (impact + exploitability), 10) : Math.min(impact + exploitability, 10);
  return roundUpToOneDecimal(base);
}

/** Maps a CVSS base score to a qualitative severity rating (CVSS v3.1 scale). */
export function severityFromScore(score: number): Severity {
  if (score <= 0) return "INFO";
  if (score < 4.0) return "LOW";
  if (score < 7.0) return "MEDIUM";
  if (score < 9.0) return "HIGH";
  return "CRITICAL";
}
