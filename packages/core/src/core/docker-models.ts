import { spawn } from "node:child_process";

// Docker Model Runner (`docker model ...`) — lets a user browse/pull real
// OCI-packaged LLM models (Docker Hub's `ai/` namespace, or HuggingFace)
// without leaving this project, then use them the same way any other
// local runtime is used (its OpenAI-compatible gateway on :12434 is
// already picked up by detectLocalProviders in local-providers.ts). This
// module only wraps the real `docker model` CLI (list/search/pull) —
// no separate catalog or download logic of our own, since Docker Hub's
// own `ai/` namespace and HuggingFace already are the catalog.

export interface DockerModelInfo {
  id: string;
  tags: string[];
  size?: string;
  parameters?: string;
  quantization?: string;
  architecture?: string;
}

export interface DockerModelSearchResult {
  name: string;
  description?: string;
  downloads: number;
  stars: number;
  source: string;
  official: boolean;
  size?: number;
}

function runDockerModel(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", ["model", ...args]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d));
    child.stderr.on("data", (d: Buffer) => (stderr += d));
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `docker model ${args.join(" ")} exited with code ${code}`));
    });
    child.on("error", reject);
  });
}

/** Real availability check — not just "is the docker binary on PATH" (see isCommandAvailable), since Model Runner is a separate feature that can be absent/disabled even with Docker itself installed. */
export async function isDockerModelRunnerAvailable(): Promise<boolean> {
  try {
    await runDockerModel(["list", "--json"]);
    return true;
  } catch {
    return false;
  }
}

export async function listDockerModels(): Promise<DockerModelInfo[]> {
  const raw = await runDockerModel(["list", "--json"]);
  const parsed = JSON.parse(raw) as {
    id: string;
    tags: string[];
    config?: { size?: string; parameters?: string; quantization?: string; architecture?: string };
  }[];
  return parsed.map((m) => ({
    id: m.id,
    tags: m.tags,
    size: m.config?.size,
    parameters: m.config?.parameters,
    quantization: m.config?.quantization,
    architecture: m.config?.architecture,
  }));
}

export async function searchDockerModels(query?: string, limit = 30): Promise<DockerModelSearchResult[]> {
  const args = ["search", "--json", `--limit=${limit}`];
  if (query) args.push(query);
  const raw = await runDockerModel(args);
  const parsed = JSON.parse(raw) as {
    Name: string;
    Description?: string;
    Downloads: number;
    Stars: number;
    Source: string;
    Official: boolean;
    Size?: number;
  }[];
  return parsed.map((m) => ({
    name: m.Name,
    description: m.Description,
    downloads: m.Downloads,
    stars: m.Stars,
    source: m.Source,
    official: m.Official,
    size: m.Size,
  }));
}

/** Removes one pulled model (frees the disk space it took up) — `docker model rm <name>`, forced so an in-use/no-longer-tagged model doesn't need a separate confirmation this wrapper has no way to relay anyway. */
export async function deleteDockerModel(name: string): Promise<void> {
  await runDockerModel(["rm", "-f", name]);
}

/** Removes every locally pulled model in one call — `docker model purge -f`, the direct fix for "these are taking up too much disk/RAM, just clear them all" rather than removing one at a time. */
export async function purgeDockerModels(): Promise<void> {
  await runDockerModel(["purge", "-f"]);
}

/**
 * Pulls a model, forwarding each real stdout/stderr line to `onLine` as it
 * arrives — no attempt to parse a progress percentage out of it (the CLI's
 * own progress-bar format isn't a stable contract), just the same raw
 * lines a terminal would show.
 */
export function pullDockerModel(name: string, onLine: (line: string) => void, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", ["model", "pull", name], { signal });
    let stderr = "";
    const forward = (d: Buffer) => {
      for (const line of d.toString().split(/\r?\n/)) if (line.trim()) onLine(line);
    };
    child.stdout.on("data", forward);
    child.stderr.on("data", (d: Buffer) => {
      stderr += d;
      forward(d);
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `docker model pull exited with code ${code}`));
    });
    child.on("error", reject);
  });
}
