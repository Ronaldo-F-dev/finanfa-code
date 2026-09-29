import type { ToolDefinition } from "../../core/types.js";
import { runSubprocess } from "../../util/process.js";

// ArgoCD/GitOps — a real, standalone capability wrapping the real `argocd`
// CLI, same "wrap the real, versioned client instead of reimplementing
// GitOps sync/health state" call as run_docker/run_kubectl. Structured
// per-operation tools (sync/app_status/app_list) rather than one raw
// subcommand-passthrough tool like run_docker: ToolDefinition.riskLevel is
// a single static value per tool (see core/types.ts), and these ops have
// genuinely different risk tiers — `app sync` triggers a real deploy,
// `app get`/`app list` are read-only — so lumping them under one riskLevel
// the way run_docker's single "dangerous" tier lumps `ps` in with `rm -f`
// would be worse here, not just different.
//
// Relies on the user's own `argocd login` session (whichever ArgoCD server
// that's pointed at) the same way run_kubectl relies on the ambient
// kubeconfig context — not this tool's job to manage auth.
const DEFAULT_TIMEOUT_MS = 300_000; // a sync can wait for a real rollout to finish

export interface ArgocdToolOptions {
  argocdBinary?: string;
}

interface ArgocdSyncInput {
  app: string;
  args?: string[];
  timeout_ms?: number;
}

interface ArgocdAppStatusInput {
  app: string;
  timeout_ms?: number;
}

interface ArgocdAppListInput {
  timeout_ms?: number;
}

export function createArgocdTools(options: ArgocdToolOptions = {}): ToolDefinition[] {
  const binary = options.argocdBinary ?? "argocd";

  const sync: ToolDefinition<ArgocdSyncInput> = {
    name: "argocd_sync",
    description:
      "Sync an ArgoCD-managed application (`argocd app sync <name>`), triggering a real deploy of the app's " +
      "current Git-tracked manifests to whatever cluster ArgoCD manages it against. Pass extra real argocd " +
      "flags in `args`, e.g. ['--prune'] (remove resources no longer in Git), ['--force'] (replace instead of " +
      "apply), ['--async'] (return immediately instead of waiting for the sync to finish). " +
      "IMPORTANT: this changes real cluster state — confirm with the user before running it unless they've " +
      "explicitly asked for this sync.",
    riskLevel: "ask",
    riskKey: () => "argocd_sync",
    inputSchema: {
      type: "object",
      properties: {
        app: { type: "string", description: "ArgoCD application name" },
        args: { type: "array", items: { type: "string" }, description: "Extra argocd flags, e.g. ['--prune'], ['--force'], ['--async']" },
        timeout_ms: { type: "number", description: `Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS})` },
      },
      required: ["app"],
    },
    describeCall: (input) => `argocd app sync ${input.app}${input.args?.length ? ` ${input.args.join(" ")}` : ""}`,
    async handler(input, ctx) {
      return runSubprocess(binary, {
        cwd: ctx.cwd,
        sessionId: ctx.sessionId,
        timeoutMs: input.timeout_ms ?? DEFAULT_TIMEOUT_MS,
        signal: ctx.signal,
        args: ["app", "sync", input.app, ...(input.args ?? [])],
      });
    },
  };

  const status: ToolDefinition<ArgocdAppStatusInput> = {
    name: "argocd_app_status",
    description:
      "Get an ArgoCD application's sync and health status (`argocd app get <name>`) — read-only, doesn't " +
      "change anything.",
    riskLevel: "safe",
    inputSchema: {
      type: "object",
      properties: {
        app: { type: "string", description: "ArgoCD application name" },
        timeout_ms: { type: "number", description: `Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS})` },
      },
      required: ["app"],
    },
    describeCall: (input) => `argocd app get ${input.app}`,
    async handler(input, ctx) {
      return runSubprocess(binary, {
        cwd: ctx.cwd,
        sessionId: ctx.sessionId,
        timeoutMs: input.timeout_ms ?? DEFAULT_TIMEOUT_MS,
        signal: ctx.signal,
        args: ["app", "get", input.app],
      });
    },
  };

  const list: ToolDefinition<ArgocdAppListInput> = {
    name: "argocd_app_list",
    description: "List all ArgoCD-managed applications (`argocd app list`) — read-only, doesn't change anything.",
    riskLevel: "safe",
    inputSchema: {
      type: "object",
      properties: {
        timeout_ms: { type: "number", description: `Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS})` },
      },
    },
    describeCall: () => "argocd app list",
    async handler(input, ctx) {
      return runSubprocess(binary, {
        cwd: ctx.cwd,
        sessionId: ctx.sessionId,
        timeoutMs: input.timeout_ms ?? DEFAULT_TIMEOUT_MS,
        signal: ctx.signal,
        args: ["app", "list"],
      });
    },
  };

  return [sync, status, list];
}
