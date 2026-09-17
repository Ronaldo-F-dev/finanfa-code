import { compareVersions, type ClawBundle } from "./claw-bundle.js";

// A real, hosted Claws registry — closing the "publish/discover bundles
// from others" gap claw-bundle.ts's own header comment left open
// ("a bundle is meant to be shared the same way a gist or a file
// attachment already is... a hosted registry to discover/search bundles
// published by others is genuinely out of scope"). Rather than running
// a bespoke multi-tenant discovery service (real infrastructure this
// project can't host on anyone's behalf), this reuses a real, already-
// existing, user-owned hosting surface: an ordinary GitHub repository,
// via GitHub's own Contents API. Publishing a bundle is a real commit to
// that repo (`bundles/<name>/<version>.json`); listing/installing reads
// it back the same way any other file in a repo is read. Any GitHub repo
// the user (or their org) already controls becomes a real registry —
// public for open sharing, private for an internal one — with GitHub's
// own real access control, no separate account system of this project's
// own to build or operate.
const GITHUB_API_BASE = "https://api.github.com";

export interface ClawsRegistryConfig {
  /** A GitHub personal access token (classic or fine-grained) with `contents:write` on the target repo — read-only operations (list/fetch) also work with a read-only token, or even no token at all on a public repo. */
  token?: string;
}

export function registryConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ClawsRegistryConfig {
  return { token: env.CLAWS_REGISTRY_TOKEN };
}

export interface ClawsRegistryTarget {
  owner: string;
  repo: string;
  /** Defaults to the repo's actual default branch when omitted (GitHub's own Contents API behavior). */
  branch?: string;
}

function bundlePath(name: string, version: string): string {
  return `bundles/${encodeURIComponent(name)}/${encodeURIComponent(version)}.json`;
}

function bundleDirPath(name: string): string {
  return `bundles/${encodeURIComponent(name)}`;
}

function authHeaders(config: ClawsRegistryConfig): Record<string, string> {
  const headers: Record<string, string> = { "user-agent": "finanfa-code", accept: "application/vnd.github+json" };
  if (config.token) headers.authorization = `Bearer ${config.token}`;
  return headers;
}

function contentsUrl(target: ClawsRegistryTarget, path: string, apiBaseUrl: string): string {
  const url = `${apiBaseUrl}/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/contents/${path}`;
  return target.branch ? `${url}?ref=${encodeURIComponent(target.branch)}` : url;
}

interface GitHubContentFile {
  type: "file" | "dir";
  name: string;
  content?: string;
  encoding?: string;
  sha: string;
}

/** Never throws — a network failure or an unparseable body comes back as status 0 with a `message`, the same shape a real GitHub error body has, so every call site can handle both uniformly via one status/message check. */
async function githubRequest(url: string, config: ClawsRegistryConfig, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  let response: Response;
  let bodyText: string;
  try {
    response = await fetch(url, { ...init, headers: { ...authHeaders(config), ...(init?.headers as Record<string, string> | undefined) } });
    bodyText = await response.text();
  } catch (err) {
    return { status: 0, body: { message: `Failed to reach GitHub: ${err instanceof Error ? err.message : String(err)}` } };
  }
  let body: unknown;
  try {
    body = bodyText ? JSON.parse(bodyText) : undefined;
  } catch {
    return { status: 0, body: { message: `GitHub returned an unparseable response (HTTP ${response.status}).` } };
  }
  return { status: response.status, body };
}

export type RegistryResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** True if a bundle at this exact name+version already exists in the registry — publishing over an existing version is refused (immutable versions, same convention as real package registries), so this is checked first. */
async function bundleVersionExists(config: ClawsRegistryConfig, target: ClawsRegistryTarget, name: string, version: string, apiBaseUrl: string): Promise<boolean> {
  const { status } = await githubRequest(contentsUrl(target, bundlePath(name, version), apiBaseUrl), config);
  return status === 200;
}

/** Publishes `bundle` to `bundles/<name>/<version>.json` in the target repo, as a real commit via GitHub's Contents API. Refuses to overwrite an already-published version — bump the bundle's own version instead. */
export async function publishBundleToRegistry(config: ClawsRegistryConfig, target: ClawsRegistryTarget, bundle: ClawBundle, apiBaseUrl = GITHUB_API_BASE): Promise<RegistryResult<{ commitSha?: string }>> {
  if (!config.token) return { ok: false, error: "No GitHub token configured — set CLAWS_REGISTRY_TOKEN (a personal access token with write access to the target repo)." };
  const { name, version } = bundle.manifest;
  if (await bundleVersionExists(config, target, name, version, apiBaseUrl)) {
    return { ok: false, error: `"${name}@${version}" is already published to ${target.owner}/${target.repo} — bump the version to publish an update.` };
  }
  const path = bundlePath(name, version);
  const { status, body } = await githubRequest(contentsUrl(target, path, apiBaseUrl), config, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      message: `Publish Claws bundle ${name}@${version}`,
      content: Buffer.from(JSON.stringify(bundle, null, 2), "utf-8").toString("base64"),
      branch: target.branch,
    }),
  });
  if (status !== 201) {
    const message = (body as { message?: string } | undefined)?.message;
    return { ok: false, error: message ?? `GitHub API error (HTTP ${status}) publishing "${name}@${version}".` };
  }
  const commitSha = (body as { commit?: { sha?: string } } | undefined)?.commit?.sha;
  return { ok: true, value: { commitSha } };
}

/** Every bundle name published under `bundles/` in the target repo. */
export async function listRegistryBundles(config: ClawsRegistryConfig, target: ClawsRegistryTarget, apiBaseUrl = GITHUB_API_BASE): Promise<RegistryResult<string[]>> {
  const { status, body } = await githubRequest(contentsUrl(target, "bundles", apiBaseUrl), config);
  if (status === 404) return { ok: true, value: [] }; // no bundles/ directory yet — an empty, not-yet-used registry, not an error
  if (status !== 200 || !Array.isArray(body)) {
    const message = (body as { message?: string } | undefined)?.message;
    return { ok: false, error: message ?? `GitHub API error (HTTP ${status}) listing bundles.` };
  }
  const entries = body as GitHubContentFile[];
  return { ok: true, value: entries.filter((e) => e.type === "dir").map((e) => e.name) };
}

/** Every version published for a given bundle name, most-recent-first (real semver-ish comparison, see compareVersions). */
export async function listRegistryBundleVersions(config: ClawsRegistryConfig, target: ClawsRegistryTarget, name: string, apiBaseUrl = GITHUB_API_BASE): Promise<RegistryResult<string[]>> {
  const { status, body } = await githubRequest(contentsUrl(target, bundleDirPath(name), apiBaseUrl), config);
  if (status === 404) return { ok: false, error: `No bundle named "${name}" published to ${target.owner}/${target.repo}.` };
  if (status !== 200 || !Array.isArray(body)) {
    const message = (body as { message?: string } | undefined)?.message;
    return { ok: false, error: message ?? `GitHub API error (HTTP ${status}) listing versions of "${name}".` };
  }
  const entries = body as GitHubContentFile[];
  const versions = entries.filter((e) => e.type === "file" && e.name.endsWith(".json")).map((e) => e.name.slice(0, -".json".length));
  versions.sort((a, b) => compareVersions(b, a));
  return { ok: true, value: versions };
}

/** Fetches a specific published bundle — omit `version` for the highest published version (real semver-ish comparison, see compareVersions), same "latest" convention a real package registry's own default install target uses. */
export async function fetchRegistryBundle(config: ClawsRegistryConfig, target: ClawsRegistryTarget, name: string, version?: string, apiBaseUrl = GITHUB_API_BASE): Promise<RegistryResult<ClawBundle>> {
  let resolvedVersion = version;
  if (!resolvedVersion) {
    const versions = await listRegistryBundleVersions(config, target, name, apiBaseUrl);
    if (!versions.ok) return versions;
    if (versions.value.length === 0) return { ok: false, error: `No bundle named "${name}" published to ${target.owner}/${target.repo}.` };
    resolvedVersion = versions.value[0];
  }

  const { status, body } = await githubRequest(contentsUrl(target, bundlePath(name, resolvedVersion), apiBaseUrl), config);
  if (status === 404) return { ok: false, error: `"${name}@${resolvedVersion}" isn't published to ${target.owner}/${target.repo}.` };
  if (status !== 200) {
    const message = (body as { message?: string } | undefined)?.message;
    return { ok: false, error: message ?? `GitHub API error (HTTP ${status}) fetching "${name}@${resolvedVersion}".` };
  }
  const file = body as GitHubContentFile;
  if (file.encoding !== "base64" || !file.content) return { ok: false, error: `Unexpected response shape fetching "${name}@${resolvedVersion}".` };
  let bundle: ClawBundle;
  try {
    bundle = JSON.parse(Buffer.from(file.content, "base64").toString("utf-8")) as ClawBundle;
  } catch (err) {
    return { ok: false, error: `"${name}@${resolvedVersion}" isn't valid bundle JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  return { ok: true, value: bundle };
}
