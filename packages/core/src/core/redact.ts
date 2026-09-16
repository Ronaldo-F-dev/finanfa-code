import { SECRET_PATTERNS, mask } from "../tools/builtin/security/patterns.js";

// Names of env vars that hold a secret this project itself reads (provider
// API keys, channel signing secrets/bot tokens, ...). A 1Password/Vault
// secret read, or a Slack/Telegram/Discord bot token, has no fixed shape a
// regex could recognize the way an AWS/Stripe/GitHub key can — so on top of
// SECRET_PATTERNS below, redactSecrets also takes an explicit denylist of
// exact values (see collectEnvSecretValues) it should scrub wherever they
// appear verbatim.
const SECRET_ENV_VAR_NAMES = [
  "ANTHROPIC_API_KEY",
  "FINANFA_API_KEY",
  "FINANFA_VISION_API_KEY",
  "OPENAI_API_KEY",
  "FONIKA_AUTH_TOKEN",
  "FONIKA_API_TOKEN",
  "SLACK_BOT_TOKEN",
  "SLACK_SIGNING_SECRET",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_WEBHOOK_SECRET",
  "DISCORD_BOT_TOKEN",
];

/** Collects the actual secret *values* (not names) of every configured secret env var, for exact-match redaction. Skips unset/short (likely test-placeholder) values. */
export function collectEnvSecretValues(env: NodeJS.ProcessEnv = process.env): string[] {
  const values: string[] = [];
  for (const name of SECRET_ENV_VAR_NAMES) {
    const value = env[name];
    if (value && value.length >= 8) values.push(value);
  }
  const apiKeys = env.FINANFA_API_KEYS;
  if (apiKeys) {
    for (const key of apiKeys.split(",").map((k) => k.trim())) {
      if (key.length >= 8) values.push(key);
    }
  }
  return values;
}

/**
 * Scrubs known-secret-shaped substrings (SECRET_PATTERNS) and any exact
 * denylisted value (this project's own configured API keys/tokens) out of
 * arbitrary text before it's persisted to disk. Used on session transcripts
 * so a tool's raw output — a 1Password/Vault secret read, an error message
 * echoing a bad token, a pasted API key — never lands on disk verbatim.
 */
export function redactSecrets(text: string, denylist: string[] = []): string {
  let result = text;
  for (const value of denylist) {
    if (!value) continue;
    result = result.split(value).join(mask(value));
  }
  for (const { pattern } of SECRET_PATTERNS) {
    result = result.replace(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`), (match) => mask(match));
  }
  return result;
}
