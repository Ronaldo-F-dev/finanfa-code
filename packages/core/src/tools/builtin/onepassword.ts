import type { ToolDefinition } from "../../core/types.js";
import { runSubprocess } from "../../util/process.js";

// Wraps the user's own already-authenticated 1Password CLI (`op`) rather
// than reimplementing any vault protocol — the same "wrap the real,
// separately-maintained tool" approach as mydevops.ts/git.ts. Only
// registered when `op` is actually installed (see builtin/index.ts).
//
// riskLevel "dangerous", never session-allowlistable the way a repeated
// "ask" tool call can become: a secret value read here becomes real,
// visible model context and gets persisted into the session transcript
// like any other tool result — there's no way to use a secret in a later
// tool call (e.g. an API request) without it passing through the model
// this way, but that's exactly why each read should stay a deliberate,
// individually-confirmed action rather than something that quietly stops
// prompting after the first approval.
export interface Read1PasswordSecretToolOptions {
  /** Overridable so tests can point this at a fake stand-in script instead of the real `op` binary. */
  binary?: string;
}

export function createRead1PasswordSecretTool(options: Read1PasswordSecretToolOptions = {}): ToolDefinition<{ reference: string }> {
  const binary = options.binary ?? "op";
  return {
    name: "read_1password_secret",
    description:
      'Read a secret from 1Password via the real `op` CLI (must already be signed in — this tool never handles ' +
      'credentials itself). `reference` is a real 1Password secret reference URI, e.g. ' +
      '"op://VaultName/ItemName/fieldName" (see `op read --help`). The returned value becomes real, visible ' +
      "model context — treat it with the same care as any other secret you'd paste into a chat.",
    riskLevel: "dangerous",
    inputSchema: {
      type: "object",
      properties: {
        reference: { type: "string", description: 'A 1Password secret reference, e.g. "op://Personal/GitHub/token"' },
      },
      required: ["reference"],
    },
    riskKey: (input) => `read_1password_secret:${input.reference}`,
    describeCall: (input) => `read 1Password secret ${input.reference}`,
    async handler(input, ctx) {
      return runSubprocess(binary, { cwd: ctx.cwd, sessionId: ctx.sessionId, signal: ctx.signal, timeoutMs: 15_000, args: ["read", input.reference] });
    },
  };
}
