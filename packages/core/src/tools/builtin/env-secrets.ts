import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import type { ToolDefinition } from "../../core/types.js";
import { resolveAllowedPath } from "./path-guard.js";
import { mask } from "./security/patterns.js";

// Local .env/.env.* file management — read (masked by default), patch a
// single KEY=VALUE line, and discover which such files exist in a
// directory. Deliberately does NOT talk to any external secret-manager
// SDK (Vault/AWS Secrets Manager/...) — read_vault_secret/
// read_1password_secret already cover that, and both of those DO return
// the real secret value (riskLevel "dangerous"), because there's no other
// way to read a value out of an external vault. Here, by contrast, the
// secret already lives in a plaintext file, so there's no reason for the
// masked-by-default path to ever put the real value in the conversation
// at all — `mask()` below is the exact same masking function
// security_scan_secrets/security_scan_storage and redact.ts's
// redactSecrets already use, reused rather than reinvented, so a secret
// value looks the same wherever it's masked in this codebase. (Checked:
// no other tool in builtin/ special-cases reading a `.env` file itself —
// read_file will happily cat one verbatim like any other text file. That
// generic path staying available is unrelated to whether *these* new
// tools are careful; they mask by construction instead of relying on any
// upstream gate.)

function unquoteValue(rawValue: string): string {
  const trimmed = rawValue.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed
      .slice(1, -1)
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  // Unquoted value: dotenv convention treats " #" as the start of an inline comment.
  const commentIdx = trimmed.search(/\s+#/);
  return (commentIdx >= 0 ? trimmed.slice(0, commentIdx) : trimmed).trim();
}

const KEY_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

/** Parses .env-format content (KEY=VALUE, `#` comments, quoted values) into an ordered key -> value map. */
export function parseEnvContent(content: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = KEY_LINE.exec(line);
    if (!match) continue;
    entries.set(match[1], unquoteValue(match[2]));
  }
  return entries;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Quotes a value only if it needs it (contains whitespace, `#`, quotes, or a newline) — keeps most values unquoted, matching typical hand-written .env style. */
function formatEnvValue(value: string): string {
  if (/[\s"'#\\\n]/.test(value)) {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
  }
  return value;
}

/**
 * Patches a single KEY=VALUE line in .env-format `content`, in place —
 * every other line (other keys, comments, blank lines, ordering) is left
 * untouched byte-for-byte. Appends a new line if `key` isn't present.
 * Exported standalone (no fs I/O) so the line-preservation logic itself
 * can be unit tested directly on strings.
 */
export function patchEnvContent(content: string, key: string, value: string): { content: string; created: boolean } {
  const keyLine = new RegExp(`^(\\s*(?:export\\s+)?)${escapeRegExp(key)}(\\s*=\\s*).*$`);
  const lines = content.length > 0 ? content.split("\n") : [];
  let found = false;
  const patched = lines.map((line) => {
    if (found) return line;
    const match = keyLine.exec(line);
    if (!match) return line;
    found = true;
    return `${match[1]}${key}${match[2]}${formatEnvValue(value)}`;
  });
  if (found) return { content: patched.join("\n"), created: false };

  const newLine = `${key}=${formatEnvValue(value)}`;
  if (patched.length === 0) return { content: newLine, created: true };
  // A trailing "" element means the original content ended with a newline
  // — reuse that slot instead of appending after it, so patching a fresh
  // key doesn't leave a stray blank line before it.
  if (patched[patched.length - 1] === "") patched[patched.length - 1] = newLine;
  else patched.push(newLine);
  return { content: patched.join("\n"), created: true };
}

interface ReadEnvFileInput {
  path: string;
  unmask?: boolean;
}

export const readEnvFileTool: ToolDefinition<ReadEnvFileInput> = {
  name: "read_env_file",
  description:
    "Read a .env-format file (KEY=VALUE lines, `#` comments, quoted values) and list its keys. By default every " +
    'value is MASKED (e.g. "sho****1234"), the real value never enters the conversation. Pass `unmask: true` ' +
    "ONLY if the real values are actually needed for the task at hand: this makes the real, unmasked secret " +
    "values part of the visible conversation and session transcript, exactly like pasting them into chat, " +
    "treat that the same way you'd treat any other real credential exposure.",
  riskLevel: "ask",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the .env file, relative to the project root or absolute" },
      unmask: { type: "boolean", description: "true reveals real values (see description), default false, values are masked" },
    },
    required: ["path"],
  },
  riskKey: (input) => `read_env_file:${input.path}:${input.unmask ? "unmask" : "masked"}`,
  describeCall: (input) => `read ${input.path}${input.unmask ? " (UNMASKED, reveals real values)" : " (masked)"}`,
  async handler(input, ctx) {
    const filePath = resolveAllowedPath(ctx.cwd, input.path);
    let raw: string;
    try {
      raw = await readFile(filePath, "utf-8");
    } catch (err) {
      return { content: `Could not read ${input.path}: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
    const entries = parseEnvContent(raw);
    if (entries.size === 0) return { content: `${input.path} has no KEY=VALUE entries.`, isError: false };
    const lines = [...entries.entries()].map(([key, value]) => `${key}=${input.unmask ? value : mask(value)}`);
    return { content: lines.join("\n"), isError: false, metadata: { keyCount: entries.size, masked: !input.unmask } };
  },
};

interface SetEnvValueInput {
  path: string;
  key: string;
  value: string;
}

export const setEnvValueTool: ToolDefinition<SetEnvValueInput> = {
  name: "set_env_value",
  description:
    "Add or update a single KEY=VALUE line in a .env file, preserving every other line's formatting/comments/order " +
    "exactly as-is, only the targeted key's line is touched (or appended, if it doesn't exist yet). Creates the " +
    "file if it doesn't exist.",
  riskLevel: "ask",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the .env file, relative to the project root or absolute" },
      key: { type: "string", description: "Environment variable name, e.g. DATABASE_URL" },
      value: { type: "string", description: "The value to set" },
    },
    required: ["path", "key", "value"],
  },
  riskKey: (input) => `set_env_value:${input.path}:${input.key}`,
  // Never interpolate the real value into the permission-prompt summary —
  // same masking rationale as read_env_file's default.
  describeCall: (input) => `set ${input.key} in ${input.path} (value: ${mask(input.value)})`,
  async handler(input, ctx) {
    const filePath = resolveAllowedPath(ctx.cwd, input.path);
    const existing = await readFile(filePath, "utf-8").catch(() => "");
    const { content, created } = patchEnvContent(existing, input.key, input.value);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content, "utf-8");
    return {
      content: `${created ? "Added" : "Updated"} ${input.key} in ${input.path} (value: ${mask(input.value)})`,
      isError: false,
    };
  },
};

interface ListEnvFilesInput {
  directory?: string;
}

export const listEnvFilesTool: ToolDefinition<ListEnvFilesInput> = {
  name: "list_env_files",
  description:
    "Find .env/.env.* files under a directory (excluding node_modules/.git) and report, for each one, just its " +
    "filename and which keys it defines, never values, masked or otherwise.",
  riskLevel: "safe",
  inputSchema: {
    type: "object",
    properties: {
      directory: { type: "string", description: "Directory to search, relative to the project root (defaults to the project root)" },
    },
  },
  describeCall: (input) => `list .env files in ${input.directory ?? "."}`,
  async handler(input, ctx) {
    const dir = input.directory ? resolveAllowedPath(ctx.cwd, input.directory) : ctx.cwd;
    const matches = await fg(["**/.env", "**/.env.*"], {
      cwd: dir,
      dot: true,
      ignore: ["**/node_modules/**", "**/.git/**"],
      onlyFiles: true,
    });
    matches.sort();
    if (matches.length === 0) return { content: `No .env files found under ${input.directory ?? "."}`, isError: false };

    const report: string[] = [];
    for (const relative of matches) {
      const raw = await readFile(path.join(dir, relative), "utf-8").catch(() => "");
      const keys = [...parseEnvContent(raw).keys()];
      report.push(`${relative}: ${keys.length > 0 ? keys.join(", ") : "(no keys found)"}`);
    }
    return { content: report.join("\n"), isError: false, metadata: { fileCount: matches.length } };
  },
};
