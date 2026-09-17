// Direct port of cyberlens's core/patterns.py — secret-shaped string
// patterns shared by security_scan_secrets and security_scan_storage.
export interface SecretPattern {
  label: string;
  pattern: RegExp;
  cwe: string;
  score: number;
}

export const SECRET_PATTERNS: SecretPattern[] = [
  { label: "Stripe secret key", pattern: /sk_(live|test)_[A-Za-z0-9]{4,}/, cwe: "CWE-209", score: 7.5 },
  { label: "AWS access key", pattern: /AKIA[0-9A-Z]{16}/, cwe: "CWE-209", score: 8.6 },
  { label: "Generic private key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, cwe: "CWE-209", score: 9.1 },
  { label: "Google API key", pattern: /AIza[0-9A-Za-z\-_]{35}/, cwe: "CWE-209", score: 7.5 },
  { label: "GitHub personal access token", pattern: /gh[pousr]_[A-Za-z0-9]{36}/, cwe: "CWE-209", score: 8.6 },
  { label: "GitHub fine-grained token", pattern: /github_pat_[A-Za-z0-9_]{22,}/, cwe: "CWE-209", score: 8.6 },
  { label: "Firebase config", pattern: /"apiKey"\s*:\s*"AIza[0-9A-Za-z\-_]{35}"[^}]*firebaseio\.com/, cwe: "CWE-209", score: 6.5 },
  { label: "Slack token", pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/, cwe: "CWE-209", score: 7.5 },
];

// Substrings in a localStorage/sessionStorage *key name* that suggest it
// holds sensitive authentication material, regardless of whether the value
// matches one of the SECRET_PATTERNS above (e.g. a raw JWT/session id has
// no fixed prefix to pattern-match on).
export const SENSITIVE_STORAGE_KEY_MARKERS = ["token", "jwt", "password", "secret", "apikey", "api_key", "auth", "session", "credential"];

export function mask(value: string): string {
  // The sliced form below keeps the first 6 + last 4 characters, which
  // only makes sense once there's at least one real character left to
  // mask in between (length > 10) — real bug, found while adding a new
  // caller: for length 9 or 10 the "middle" is negative/zero, and
  // "*".repeat(value.length - 10) throws RangeError: Invalid count value
  // for exactly length 9. Mask the whole thing for anything that short.
  if (value.length <= 10) return "*".repeat(value.length);
  return `${value.slice(0, 6)}${"*".repeat(value.length - 10)}${value.slice(-4)}`;
}
