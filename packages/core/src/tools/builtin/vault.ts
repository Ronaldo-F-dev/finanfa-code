import type { ToolDefinition } from "../../core/types.js";
import { runSubprocess } from "../../util/process.js";

// Wraps the user's own already-authenticated HashiCorp Vault CLI
// (`vault`, expects VAULT_ADDR/VAULT_TOKEN already set up in the
// environment — this tool never handles auth itself), the KV v2 read
// path (`vault kv get -field=<field> <path>`), which covers the common
// case of pulling one secret value out of a KV secrets engine. Same
// "wrap the real CLI" approach as onepassword.ts/mydevops.ts/git.ts.
// Only registered when `vault` is actually installed (see
// builtin/index.ts).
//
// riskLevel "dangerous" — see onepassword.ts's own comment on why a
// secret read is never session-allowlistable the way a repeated "ask"
// tool call can become.
export interface ReadVaultSecretToolOptions {
  /** Overridable so tests can point this at a fake stand-in script instead of the real `vault` binary. */
  binary?: string;
}

export function createReadVaultSecretTool(options: ReadVaultSecretToolOptions = {}): ToolDefinition<{ path: string; field: string }> {
  const binary = options.binary ?? "vault";
  return {
    name: "read_vault_secret",
    description:
      "Read one field of a secret from HashiCorp Vault via the real `vault` CLI (must already be authenticated " +
      "— VAULT_ADDR/VAULT_TOKEN already set up in the environment; this tool never handles credentials itself). " +
      '`path` is the KV v2 secret path (e.g. "secret/data/myapp/db" or just "secret/myapp/db" depending on your ' +
      'mount), `field` is the key within it (e.g. "password"). The returned value becomes real, visible model ' +
      "context — treat it with the same care as any other secret you'd paste into a chat.",
    riskLevel: "dangerous",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: 'Vault KV secret path, e.g. "secret/myapp/db"' },
        field: { type: "string", description: 'The field within that secret to read, e.g. "password"' },
      },
      required: ["path", "field"],
    },
    riskKey: (input) => `read_vault_secret:${input.path}:${input.field}`,
    describeCall: (input) => `read Vault secret ${input.path} (field: ${input.field})`,
    async handler(input, ctx) {
      return runSubprocess(binary, { cwd: ctx.cwd, sessionId: ctx.sessionId, signal: ctx.signal, timeoutMs: 15_000, args: ["kv", "get", `-field=${input.field}`, input.path] });
    },
  };
}
