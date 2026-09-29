import { spawn } from "node:child_process";
import type { ToolDefinition } from "../../core/types.js";
import { runSubprocess } from "../../util/process.js";
import { isCommandAvailable } from "../../util/command-availability.js";

// Docker Compose stacks + cloud container registry login — real
// capabilities run_docker's raw `docker` passthrough doesn't cover well:
// compose needs its own subcommand shape (a compose *project*, not a
// single container), and registry login needs a real cloud CLI (aws/az/
// gcloud) in the loop, which run_docker has no reason to know about.
//
// Compose is split into two tools rather than one, even though real
// `docker compose` has one subcommand namespace for all four verbs:
// ToolDefinition.riskLevel (core/types.ts) is a single static value per
// tool, and up/down really do mutate real infra (containers, volumes,
// networks) while ps/logs are read-only — a single riskLevel would force
// picking one tier for both, same problem argocd.ts's split avoids.
const DEFAULT_COMPOSE_TIMEOUT_MS = 300_000; // `up` can pull/build images
const DEFAULT_STATUS_TIMEOUT_MS = 60_000;
const DEFAULT_LOGIN_TIMEOUT_MS = 60_000;

export interface DockerComposeToolOptions {
  /** Modern form: `<dockerBinary> compose ...`. Defaults to "docker". */
  dockerBinary?: string;
  /** Legacy standalone fallback, used only if dockerBinary isn't available. Defaults to "docker-compose". */
  dockerComposeBinary?: string;
}

export interface DockerRegistryLoginToolOptions {
  dockerBinary?: string;
  awsBinary?: string;
  azBinary?: string;
  gcloudBinary?: string;
}

interface ComposeInvocation {
  bin: string;
  /** Leading args before the compose file/verb, e.g. ["compose"] for `docker compose`, [] for standalone `docker-compose`. */
  prefix: string[];
}

/** Prefers the modern `docker compose` plugin form; falls back to the legacy standalone `docker-compose` binary if `docker` itself isn't on PATH. Mirrors the real-world situation: a `docker` binary present but missing the compose plugin fails with docker's own clear stderr ("is not a docker command"), which the caller passes through rather than trying to guess plugin availability up front. */
function resolveComposeInvocation(opts: DockerComposeToolOptions): ComposeInvocation | { error: string } {
  const dockerBin = opts.dockerBinary ?? "docker";
  const composeBin = opts.dockerComposeBinary ?? "docker-compose";
  if (isCommandAvailable(dockerBin)) return { bin: dockerBin, prefix: ["compose"] };
  if (isCommandAvailable(composeBin)) return { bin: composeBin, prefix: [] };
  return {
    error:
      `Neither the modern \`${dockerBin} compose\` (Docker CLI + Compose plugin) nor the legacy standalone ` +
      `\`${composeBin}\` binary is available — install Docker Desktop (or the Compose plugin) or the standalone ` +
      "docker-compose CLI, and ensure it's on PATH.",
  };
}

interface DockerComposeUpDownInput {
  subcommand: "up" | "down";
  file?: string;
  args?: string[];
  timeout_ms?: number;
}

/** `docker compose up`/`down` — mutates real local (or remote-context) infra: containers, networks, volumes. */
export function createDockerComposeUpDownTool(options: DockerComposeToolOptions = {}): ToolDefinition<DockerComposeUpDownInput> {
  return {
    name: "docker_compose",
    description:
      "Bring a Docker Compose stack up or down (`docker compose [-f <file>] up|down ...`), preferring the " +
      "modern `docker compose` plugin form and falling back to the legacy standalone `docker-compose` binary. " +
      "Pass extra real compose flags/service names in `args`, e.g. ['-d'] or ['--build'] for up, " +
      "['--volumes'] or ['--remove-orphans'] for down, or a specific service name to target one service. " +
      "IMPORTANT: both subcommands change real infra state (containers/networks/volumes) — confirm with the " +
      "user before running one unless they've explicitly asked for it.",
    riskLevel: "ask",
    riskKey: (input) => `docker_compose:${input.subcommand}`,
    inputSchema: {
      type: "object",
      properties: {
        subcommand: { type: "string", enum: ["up", "down"], description: "Compose verb to run" },
        file: { type: "string", description: "Path to the compose file, relative to the project root (passed as -f <file>). Defaults to compose's own discovery (docker-compose.yml in cwd) if omitted." },
        args: { type: "array", items: { type: "string" }, description: "Extra real compose flags/service names, e.g. ['-d'], ['--build'], ['--remove-orphans']" },
        timeout_ms: { type: "number", description: `Timeout in milliseconds (default ${DEFAULT_COMPOSE_TIMEOUT_MS})` },
      },
      required: ["subcommand"],
    },
    describeCall: (input) =>
      `docker compose ${input.file ? `-f ${input.file} ` : ""}${input.subcommand}${input.args?.length ? ` ${input.args.join(" ")}` : ""}`,
    async handler(input, ctx) {
      const invocation = resolveComposeInvocation(options);
      if ("error" in invocation) return { content: invocation.error, isError: true };
      const args = [...invocation.prefix, ...(input.file ? ["-f", input.file] : []), input.subcommand, ...(input.args ?? [])];
      return runSubprocess(invocation.bin, {
        cwd: ctx.cwd,
        sessionId: ctx.sessionId,
        timeoutMs: input.timeout_ms ?? DEFAULT_COMPOSE_TIMEOUT_MS,
        signal: ctx.signal,
        args,
      });
    },
  };
}

interface DockerComposeStatusInput {
  subcommand: "ps" | "logs";
  file?: string;
  service?: string;
  args?: string[];
  timeout_ms?: number;
}

/** `docker compose ps`/`logs` — read-only introspection of an already-running stack. */
export function createDockerComposeStatusTool(options: DockerComposeToolOptions = {}): ToolDefinition<DockerComposeStatusInput> {
  return {
    name: "docker_compose_status",
    description:
      "Inspect a Docker Compose stack (`docker compose [-f <file>] ps|logs [service]`), read-only — lists " +
      "container status (ps) or shows logs (logs), preferring the modern `docker compose` plugin form and " +
      "falling back to the legacy standalone `docker-compose` binary. Pass extra real flags in `args`, e.g. " +
      "['--tail', '100'] or ['-f'] to follow logs (note: following blocks until the tool's timeout).",
    riskLevel: "safe",
    inputSchema: {
      type: "object",
      properties: {
        subcommand: { type: "string", enum: ["ps", "logs"], description: "Compose verb to run" },
        file: { type: "string", description: "Path to the compose file, relative to the project root (passed as -f <file>)." },
        service: { type: "string", description: "Limit to a single service name" },
        args: { type: "array", items: { type: "string" }, description: "Extra real compose flags, e.g. ['--tail', '100'], ['-f']" },
        timeout_ms: { type: "number", description: `Timeout in milliseconds (default ${DEFAULT_STATUS_TIMEOUT_MS})` },
      },
      required: ["subcommand"],
    },
    describeCall: (input) =>
      `docker compose ${input.file ? `-f ${input.file} ` : ""}${input.subcommand}${input.args?.length ? ` ${input.args.join(" ")}` : ""}${input.service ? ` ${input.service}` : ""}`,
    async handler(input, ctx) {
      const invocation = resolveComposeInvocation(options);
      if ("error" in invocation) return { content: invocation.error, isError: true };
      const args = [
        ...invocation.prefix,
        ...(input.file ? ["-f", input.file] : []),
        input.subcommand,
        ...(input.args ?? []),
        ...(input.service ? [input.service] : []),
      ];
      return runSubprocess(invocation.bin, {
        cwd: ctx.cwd,
        sessionId: ctx.sessionId,
        timeoutMs: input.timeout_ms ?? DEFAULT_STATUS_TIMEOUT_MS,
        signal: ctx.signal,
        args,
      });
    },
  };
}

interface SpawnCaptureResult {
  stdout: string;
  stderr: string;
  code: number | null;
  error?: NodeJS.ErrnoException;
}

/** Real spawn + optional stdin write, used for the ECR flow's real `aws ecr get-login-password | docker login --password-stdin` pipe — no shell string, so the password never touches a shell command line. */
function spawnCapture(bin: string, args: string[], opts: { cwd: string; timeoutMs: number; signal?: AbortSignal; stdin?: string }): Promise<SpawnCaptureResult> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd: opts.cwd });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs);
    const onAbort = () => child.kill("SIGKILL");
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (d) => (stdout += d));
    child.stderr?.on("data", (d) => (stderr += d));
    child.on("close", (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({ stdout, stderr, code });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({ stdout, stderr, code: null, error: error as NodeJS.ErrnoException });
    });
    if (opts.stdin !== undefined) {
      child.stdin?.write(opts.stdin);
    }
    child.stdin?.end();
  });
}

function formatResult(header: string, result: SpawnCaptureResult): { content: string; isError: boolean } {
  if (result.error) {
    return { content: `${header}Failed to run: ${result.error.message}`, isError: true };
  }
  const content = `${header}(exit code ${result.code})\n${result.stdout}${result.stderr ? `\n--- stderr ---\n${result.stderr}` : ""}`;
  return { content, isError: result.code !== 0 };
}

interface DockerRegistryLoginInput {
  provider: "ecr" | "acr" | "gcr";
  // ecr
  region?: string;
  accountId?: string;
  // acr
  registryName?: string;
  // gcr / Artifact Registry
  registries?: string[];
  timeout_ms?: number;
}

/**
 * Logs docker in to one of the 3 major cloud container registries by
 * shelling out to that cloud's own CLI (aws/az/gcloud) — each of those
 * must already be installed *and authenticated*; this tool only bridges
 * "already-authenticated cloud CLI" to "docker can push/pull", the same
 * boundary run_docker/run_kubectl draw around their own real CLIs.
 */
export function createDockerRegistryLoginTool(options: DockerRegistryLoginToolOptions = {}): ToolDefinition<DockerRegistryLoginInput> {
  const dockerBin = options.dockerBinary ?? "docker";
  const awsBin = options.awsBinary ?? "aws";
  const azBin = options.azBinary ?? "az";
  const gcloudBin = options.gcloudBinary ?? "gcloud";

  return {
    name: "docker_registry_login",
    description:
      "Log docker in to a cloud container registry so subsequent `docker push`/`pull` work, by delegating to " +
      "that cloud's own CLI: ECR (`aws ecr get-login-password | docker login --username AWS --password-stdin " +
      "<account>.dkr.ecr.<region>.amazonaws.com`, needs `region` + `accountId`), ACR (`az acr login --name " +
      "<registryName>`, needs `registryName`), or GCR/Artifact Registry (`gcloud auth configure-docker " +
      "<registries>`, `registries` optional — defaults to gcr.io). " +
      "IMPORTANT: requires the respective cloud CLI (aws/az/gcloud) to already be installed and authenticated " +
      "(aws configure / az login / gcloud auth login) — this tool only bridges that existing cloud auth to " +
      "docker, it doesn't perform cloud login itself. Touches real cloud credentials — confirm with the user " +
      "before running unless they've explicitly asked for it.",
    riskLevel: "ask",
    riskKey: (input) => `docker_registry_login:${input.provider}`,
    inputSchema: {
      type: "object",
      properties: {
        provider: { type: "string", enum: ["ecr", "acr", "gcr"], description: "Which cloud registry to log in to" },
        region: { type: "string", description: "AWS region (ecr only), e.g. 'us-east-1'" },
        accountId: { type: "string", description: "AWS account ID (ecr only)" },
        registryName: { type: "string", description: "ACR registry name, e.g. 'myregistry' (acr only)" },
        registries: { type: "array", items: { type: "string" }, description: "GCR/Artifact Registry hostnames to configure, e.g. ['gcr.io'] or ['us-docker.pkg.dev'] (gcr only, defaults to ['gcr.io'])" },
        timeout_ms: { type: "number", description: `Timeout in milliseconds (default ${DEFAULT_LOGIN_TIMEOUT_MS})` },
      },
      required: ["provider"],
    },
    describeCall: (input) => {
      if (input.provider === "ecr") return `aws ecr get-login-password --region ${input.region} | docker login --password-stdin (account ${input.accountId})`;
      if (input.provider === "acr") return `az acr login --name ${input.registryName}`;
      return `gcloud auth configure-docker ${(input.registries?.length ? input.registries : ["gcr.io"]).join(",")}`;
    },
    async handler(input, ctx) {
      const timeoutMs = input.timeout_ms ?? DEFAULT_LOGIN_TIMEOUT_MS;

      if (input.provider === "ecr") {
        if (!input.region || !input.accountId) {
          return { content: "docker_registry_login: 'region' and 'accountId' are both required for provider 'ecr'.", isError: true };
        }
        if (!isCommandAvailable(awsBin)) {
          return { content: `docker_registry_login: the AWS CLI (\`${awsBin}\`) is not installed/on PATH — install it and run \`aws configure\` (or otherwise authenticate) first.`, isError: true };
        }
        if (!isCommandAvailable(dockerBin)) {
          return { content: `docker_registry_login: the Docker CLI (\`${dockerBin}\`) is not installed/on PATH.`, isError: true };
        }
        const pw = await spawnCapture(awsBin, ["ecr", "get-login-password", "--region", input.region], { cwd: ctx.cwd, timeoutMs, signal: ctx.signal });
        if (pw.error || pw.code !== 0) {
          return formatResult(`aws ecr get-login-password --region ${input.region}\n`, pw);
        }
        const registryUrl = `${input.accountId}.dkr.ecr.${input.region}.amazonaws.com`;
        const login = await spawnCapture(dockerBin, ["login", "--username", "AWS", "--password-stdin", registryUrl], {
          cwd: ctx.cwd,
          timeoutMs,
          signal: ctx.signal,
          stdin: pw.stdout.trim(),
        });
        return formatResult(`docker login --username AWS --password-stdin ${registryUrl}\n`, login);
      }

      if (input.provider === "acr") {
        if (!input.registryName) {
          return { content: "docker_registry_login: 'registryName' is required for provider 'acr'.", isError: true };
        }
        if (!isCommandAvailable(azBin)) {
          return { content: `docker_registry_login: the Azure CLI (\`${azBin}\`) is not installed/on PATH — install it and run \`az login\` first.`, isError: true };
        }
        return runSubprocess(azBin, { cwd: ctx.cwd, sessionId: ctx.sessionId, timeoutMs, signal: ctx.signal, args: ["acr", "login", "--name", input.registryName] });
      }

      // gcr
      if (!isCommandAvailable(gcloudBin)) {
        return { content: `docker_registry_login: the Google Cloud CLI (\`${gcloudBin}\`) is not installed/on PATH — install it and run \`gcloud auth login\` first.`, isError: true };
      }
      const registries = input.registries?.length ? input.registries : ["gcr.io"];
      return runSubprocess(gcloudBin, {
        cwd: ctx.cwd,
        sessionId: ctx.sessionId,
        timeoutMs,
        signal: ctx.signal,
        args: ["auth", "configure-docker", registries.join(","), "--quiet"],
      });
    },
  };
}
