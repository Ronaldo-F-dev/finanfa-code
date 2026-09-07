import type { ToolDefinition } from "../../core/types.js";
import { runSubprocess } from "../../util/process.js";

// A generic passthrough wrapper around the user's own separate,
// already-built DevOps CLI (`mydevops`, github.com:Ronaldo-F-dev/mydevops
// — Terraform/Ansible provisioning, Docker/Kubernetes, CI/CD pipeline
// generation, GitOps/ArgoCD, Prometheus/Grafana monitoring, centralized
// logging, secrets rotation, blue-green/canary deploys, and more — ~55
// subcommands), rather than reimplementing any of that DevOps surface
// natively in this project. mydevops is a real, mature, independently
// maintained tool; wrapping it (the same way git.ts wraps `git`) exposes
// its entire current AND future command surface for free, instead of
// duplicating a fraction of it and having the two drift apart.
//
// The binary name is injectable (defaults to "mydevops") so tests can
// point this at a fake stand-in script instead of the real one — the
// real mydevops binary is snap-packaged and doesn't run inside this
// project's own dev sandbox (confirmed: exits immediately with code 120,
// a snap-confinement issue in that specific sandboxed environment, not a
// bug in this wrapper), so its actual behavior can't be exercised here
// either way; the underlying subprocess mechanism (runSubprocess) is
// already covered by bash.ts/run-tests.ts's own tests.
//
// riskLevel "dangerous", same tier as bash: mydevops has commands
// spanning pure information (whoami, info, doctor, inventory) through to
// genuinely irreversible ones (destroy, deploy, ssl, vpn) — riskKey scopes
// permission by subcommand (mydevops:destroy vs mydevops:whoami) so a
// user can allow-list the read-only ones without blanket-approving
// everything, the same pattern bash.ts uses for its own command prefix.
const DEFAULT_TIMEOUT_MS = 300_000; // infra operations (terraform apply, eks provisioning, ...) can run far longer than a typical bash call

export interface MydevopsToolOptions {
  binary?: string;
}

interface MydevopsInput {
  subcommand: string;
  args?: string[];
  cwd?: string;
  timeout_ms?: number;
}

export function createMydevopsTool(options: MydevopsToolOptions = {}): ToolDefinition<MydevopsInput> {
  const binary = options.binary ?? "mydevops";

  return {
    name: "run_mydevops",
    description:
      "Run a subcommand of the user's own mydevops CLI (real, separately-maintained DevOps tool — see " +
      "`mydevops help`/`mydevops --help` for the full list): Terraform/Ansible provisioning, Docker/Kubernetes " +
      "deploys, CI/CD pipeline generation (GitHub Actions/GitLab CI/Jenkins/Azure Pipelines), GitOps/ArgoCD, " +
      "Prometheus/Grafana monitoring, centralized logging (Loki/ELK), secrets rotation, blue-green/canary " +
      "deploys, SSL/DNS/VPN management, and more. Pass the subcommand (e.g. 'doctor', 'deploy', 'k8s') and its " +
      "own args as a plain array — never as one shell string. Some subcommands are read-only/informational " +
      "(whoami, info, doctor, inventory, score, stats) and some are genuinely irreversible (destroy, deploy, " +
      "ssl, vpn) — treat the latter with the same caution as a real production infrastructure change, and " +
      "confirm with the user before running one. " +
      "IMPORTANT: this operates on the user's REAL infrastructure/servers/cloud accounts, not a sandbox.",
    riskLevel: "dangerous",
    inputSchema: {
      type: "object",
      properties: {
        subcommand: { type: "string", description: "mydevops subcommand, e.g. 'doctor', 'deploy', 'k8s', 'destroy'" },
        args: { type: "array", items: { type: "string" }, description: "Arguments/flags for the subcommand, e.g. ['--env', 'production']" },
        cwd: { type: "string", description: "Working directory to run mydevops in, relative to the project root (defaults to the project root — mydevops reads its config from mydevops.yml in the current directory)" },
        timeout_ms: { type: "number", description: "Timeout in milliseconds (default 300000 — infra operations can be slow)" },
      },
      required: ["subcommand"],
    },
    riskKey: (input) => `mydevops:${input.subcommand}`,
    describeCall: (input) => `mydevops ${input.subcommand}${input.args?.length ? ` ${input.args.join(" ")}` : ""}`,
    async handler(input, ctx) {
      const cwd = input.cwd ? `${ctx.cwd}/${input.cwd}` : ctx.cwd;
      const timeoutMs = input.timeout_ms ?? DEFAULT_TIMEOUT_MS;
      return runSubprocess(binary, { cwd, sessionId: ctx.sessionId, timeoutMs, signal: ctx.signal, args: [input.subcommand, ...(input.args ?? [])] });
    },
  };
}
