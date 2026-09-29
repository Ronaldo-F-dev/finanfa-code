import type { ToolDefinition } from "../../core/types.js";
import { runSubprocess } from "../../util/process.js";

// Terraform — a real, standalone capability wrapping the real `terraform`
// CLI, same "wrap the real, versioned client instead of reimplementing its
// HCL/provider/state logic" call as run_docker/run_kubectl/argocd. Structured
// per-operation tools (init/plan/apply/destroy/output/validate) rather than
// one raw subcommand-passthrough tool, for the same reason as argocd.ts:
// ToolDefinition.riskLevel is a single static value per tool, and these ops
// have genuinely different risk tiers — `plan`/`validate`/`output` are
// read-only, `apply`/`destroy` change real infrastructure.
//
// `-auto-approve` is required on apply/destroy because there's no
// interactive terminal here for terraform's own y/n confirmation prompt —
// this tool's own "ask" risk tier is where real confirmation now happens
// (same reasoning security/nmap.ts documents for not double-gating).
const DEFAULT_TIMEOUT_MS = 600_000; // a plan/apply/destroy can wait on real provider APIs for a while

export interface TerraformToolOptions {
  terraformBinary?: string;
}

interface TerraformDirInput {
  directory: string;
  args?: string[];
  timeout_ms?: number;
}

export function createTerraformTools(options: TerraformToolOptions = {}): ToolDefinition[] {
  const binary = options.terraformBinary ?? "terraform";

  const init: ToolDefinition<TerraformDirInput> = {
    name: "terraform_init",
    description:
      "Initialize a Terraform working directory (`terraform init`) — downloads providers/modules and sets up " +
      "backend state. Doesn't change any infrastructure. Pass extra real terraform flags in `args`, e.g. " +
      "['-upgrade'], ['-reconfigure'].",
    riskLevel: "safe",
    inputSchema: {
      type: "object",
      properties: {
        directory: { type: "string", description: "Terraform working directory (where the .tf files / .terraform state live) — never assume repo root" },
        args: { type: "array", items: { type: "string" }, description: "Extra terraform flags, e.g. ['-upgrade'], ['-reconfigure']" },
        timeout_ms: { type: "number", description: `Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS})` },
      },
      required: ["directory"],
    },
    describeCall: (input) => `terraform init${input.args?.length ? ` ${input.args.join(" ")}` : ""} (in ${input.directory})`,
    async handler(input, ctx) {
      return runSubprocess(binary, {
        cwd: input.directory,
        sessionId: ctx.sessionId,
        timeoutMs: input.timeout_ms ?? DEFAULT_TIMEOUT_MS,
        signal: ctx.signal,
        args: ["init", ...(input.args ?? [])],
      });
    },
  };

  const plan: ToolDefinition<TerraformDirInput> = {
    name: "terraform_plan",
    description:
      "Compute a Terraform execution plan (`terraform plan`) — read-only, shows what would change without " +
      "applying it. Pass extra real terraform flags in `args`, e.g. ['-var-file=prod.tfvars'], ['-out=plan.tfplan'].",
    riskLevel: "safe",
    inputSchema: {
      type: "object",
      properties: {
        directory: { type: "string", description: "Terraform working directory (where the .tf files / .terraform state live) — never assume repo root" },
        args: { type: "array", items: { type: "string" }, description: "Extra terraform flags, e.g. ['-var-file=prod.tfvars'], ['-out=plan.tfplan']" },
        timeout_ms: { type: "number", description: `Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS})` },
      },
      required: ["directory"],
    },
    describeCall: (input) => `terraform plan${input.args?.length ? ` ${input.args.join(" ")}` : ""} (in ${input.directory})`,
    async handler(input, ctx) {
      return runSubprocess(binary, {
        cwd: input.directory,
        sessionId: ctx.sessionId,
        timeoutMs: input.timeout_ms ?? DEFAULT_TIMEOUT_MS,
        signal: ctx.signal,
        args: ["plan", ...(input.args ?? [])],
      });
    },
  };

  const apply: ToolDefinition<TerraformDirInput> = {
    name: "terraform_apply",
    description:
      "Apply a Terraform plan (`terraform apply -auto-approve`), provisioning/changing REAL infrastructure. " +
      "-auto-approve is used because there's no interactive terminal here for terraform's own confirmation " +
      "prompt — this tool asking for confirmation before running is what stands in for it. Pass extra real " +
      "terraform flags in `args`, e.g. ['-var-file=prod.tfvars'], ['-target=aws_instance.foo']. " +
      "IMPORTANT: this changes real infrastructure without terraform's own interactive y/n confirmation — " +
      "confirm with the user before running it unless they've explicitly asked for this apply.",
    riskLevel: "ask",
    inputSchema: {
      type: "object",
      properties: {
        directory: { type: "string", description: "Terraform working directory (where the .tf files / .terraform state live) — never assume repo root" },
        args: { type: "array", items: { type: "string" }, description: "Extra terraform flags, e.g. ['-var-file=prod.tfvars'], ['-target=aws_instance.foo']" },
        timeout_ms: { type: "number", description: `Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS})` },
      },
      required: ["directory"],
    },
    describeCall: (input) =>
      `terraform apply -auto-approve${input.args?.length ? ` ${input.args.join(" ")}` : ""} (in ${input.directory}) — ` +
      "applies real infra changes without terraform's own interactive confirmation",
    async handler(input, ctx) {
      return runSubprocess(binary, {
        cwd: input.directory,
        sessionId: ctx.sessionId,
        timeoutMs: input.timeout_ms ?? DEFAULT_TIMEOUT_MS,
        signal: ctx.signal,
        args: ["apply", "-auto-approve", ...(input.args ?? [])],
      });
    },
  };

  const destroy: ToolDefinition<TerraformDirInput> = {
    name: "terraform_destroy",
    description:
      "Destroy all Terraform-managed infrastructure in this working directory (`terraform destroy -auto-approve`) " +
      "— DESTROYS REAL INFRASTRUCTURE, irreversibly. -auto-approve is used because there's no interactive " +
      "terminal here for terraform's own confirmation prompt — this tool asking for confirmation before " +
      "running is what stands in for it. Pass extra real terraform flags in `args`, e.g. " +
      "['-var-file=prod.tfvars'], ['-target=aws_instance.foo']. " +
      "IMPORTANT: this destroys real infrastructure without terraform's own interactive y/n confirmation — " +
      "confirm with the user before running it unless they've explicitly asked for this destroy.",
    riskLevel: "ask",
    riskKey: () => "terraform_destroy",
    inputSchema: {
      type: "object",
      properties: {
        directory: { type: "string", description: "Terraform working directory (where the .tf files / .terraform state live) — never assume repo root" },
        args: { type: "array", items: { type: "string" }, description: "Extra terraform flags, e.g. ['-var-file=prod.tfvars'], ['-target=aws_instance.foo']" },
        timeout_ms: { type: "number", description: `Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS})` },
      },
      required: ["directory"],
    },
    describeCall: (input) =>
      `terraform destroy -auto-approve${input.args?.length ? ` ${input.args.join(" ")}` : ""} (in ${input.directory}) — ` +
      "DESTROYS real infrastructure without terraform's own interactive confirmation",
    async handler(input, ctx) {
      return runSubprocess(binary, {
        cwd: input.directory,
        sessionId: ctx.sessionId,
        timeoutMs: input.timeout_ms ?? DEFAULT_TIMEOUT_MS,
        signal: ctx.signal,
        args: ["destroy", "-auto-approve", ...(input.args ?? [])],
      });
    },
  };

  const output: ToolDefinition<TerraformDirInput> = {
    name: "terraform_output",
    description:
      "Read Terraform output values (`terraform output -json`) — read-only, doesn't change anything. Pass " +
      "`args` to override the format (e.g. [] for plain text, ['-raw', 'some_output'] for a single raw value); " +
      "when `args` is given, -json is NOT added automatically.",
    riskLevel: "safe",
    inputSchema: {
      type: "object",
      properties: {
        directory: { type: "string", description: "Terraform working directory (where the .tf files / .terraform state live) — never assume repo root" },
        args: { type: "array", items: { type: "string" }, description: "Extra terraform flags overriding the default -json, e.g. [] for plain text, ['-raw', 'some_output']" },
        timeout_ms: { type: "number", description: `Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS})` },
      },
      required: ["directory"],
    },
    describeCall: (input) => `terraform output ${input.args?.length ? input.args.join(" ") : "-json"} (in ${input.directory})`,
    async handler(input, ctx) {
      return runSubprocess(binary, {
        cwd: input.directory,
        sessionId: ctx.sessionId,
        timeoutMs: input.timeout_ms ?? DEFAULT_TIMEOUT_MS,
        signal: ctx.signal,
        args: ["output", ...(input.args ?? ["-json"])],
      });
    },
  };

  const validate: ToolDefinition<Omit<TerraformDirInput, "args">> = {
    name: "terraform_validate",
    description: "Validate the Terraform configuration's syntax and internal consistency (`terraform validate`) — read-only, doesn't change anything.",
    riskLevel: "safe",
    inputSchema: {
      type: "object",
      properties: {
        directory: { type: "string", description: "Terraform working directory (where the .tf files / .terraform state live) — never assume repo root" },
        timeout_ms: { type: "number", description: `Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS})` },
      },
      required: ["directory"],
    },
    describeCall: (input) => `terraform validate (in ${input.directory})`,
    async handler(input, ctx) {
      return runSubprocess(binary, {
        cwd: input.directory,
        sessionId: ctx.sessionId,
        timeoutMs: input.timeout_ms ?? DEFAULT_TIMEOUT_MS,
        signal: ctx.signal,
        args: ["validate"],
      });
    },
  };

  return [init, plan, apply, destroy, output, validate];
}
