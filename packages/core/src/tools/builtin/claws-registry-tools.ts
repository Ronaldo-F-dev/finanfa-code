import type { ToolDefinition } from "../../core/types.js";
import { publishBundleToRegistry, listRegistryBundles, listRegistryBundleVersions, fetchRegistryBundle, type ClawsRegistryConfig } from "../../core/claws-registry.js";
import { installClawBundle, type ClawBundle } from "../../core/claw-bundle.js";

interface RegistryTargetInput {
  owner: string;
  repo: string;
  branch?: string;
}

interface PublishBundleToRegistryInput extends RegistryTargetInput {
  bundle_json: string;
}

export function createPublishBundleToRegistryTool(config: ClawsRegistryConfig, apiBaseUrl?: string): ToolDefinition<PublishBundleToRegistryInput> {
  return {
    name: "publish_bundle_to_registry",
    description:
      "Publish a bundle (from export_bundle) to a real, hosted Claws registry — any GitHub repository the " +
      "user (or their org) already controls, public for open sharing or private for an internal one. Commits the " +
      "bundle to `bundles/<name>/<version>.json` in that repo via GitHub's real Contents API. Refuses to overwrite " +
      "an already-published version — bump the bundle's own version to publish an update. Requires " +
      "CLAWS_REGISTRY_TOKEN (a GitHub personal access token with write access to the target repo) to be set.",
    riskLevel: "ask",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: 'Repo owner/org, e.g. "acme-corp"' },
        repo: { type: "string", description: 'Repo name, e.g. "claws-registry"' },
        branch: { type: "string", description: "Defaults to the repo's actual default branch" },
        bundle_json: { type: "string", description: "The bundle's JSON, exactly as export_bundle produced it" },
      },
      required: ["owner", "repo", "bundle_json"],
    },
    describeCall: (input) => {
      try {
        const bundle = JSON.parse(input.bundle_json) as ClawBundle;
        return `publish bundle "${bundle.manifest.name}@${bundle.manifest.version}" to ${input.owner}/${input.repo}`;
      } catch {
        return `publish bundle to ${input.owner}/${input.repo} (unparseable JSON — will fail)`;
      }
    },
    async handler(input) {
      let bundle: ClawBundle;
      try {
        bundle = JSON.parse(input.bundle_json) as ClawBundle;
      } catch (err) {
        return { content: `Not valid bundle JSON: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
      if (!bundle.manifest?.name || !bundle.manifest?.version || !bundle.files) {
        return { content: "Not a valid bundle — missing manifest.name/version or files.", isError: true };
      }
      const result = await publishBundleToRegistry(config, { owner: input.owner, repo: input.repo, branch: input.branch }, bundle, apiBaseUrl);
      if (!result.ok) return { content: result.error, isError: true };
      return { content: `Published "${bundle.manifest.name}@${bundle.manifest.version}" to ${input.owner}/${input.repo}.`, isError: false };
    },
  };
}

export function createListRegistryBundlesTool(config: ClawsRegistryConfig, apiBaseUrl?: string): ToolDefinition<RegistryTargetInput> {
  return {
    name: "list_registry_bundles",
    description: "List every bundle name published to a Claws registry (a GitHub repo — see publish_bundle_to_registry). Works read-only, no token required for a public repo.",
    riskLevel: "safe",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        branch: { type: "string" },
      },
      required: ["owner", "repo"],
    },
    describeCall: (input) => `list bundles published to ${input.owner}/${input.repo}`,
    async handler(input) {
      const result = await listRegistryBundles(config, { owner: input.owner, repo: input.repo, branch: input.branch }, apiBaseUrl);
      if (!result.ok) return { content: result.error, isError: true };
      if (result.value.length === 0) return { content: `No bundles published to ${input.owner}/${input.repo} yet.`, isError: false };
      return { content: result.value.join("\n"), isError: false };
    },
  };
}

interface RegistryBundleNameInput extends RegistryTargetInput {
  name: string;
}

export function createListRegistryBundleVersionsTool(config: ClawsRegistryConfig, apiBaseUrl?: string): ToolDefinition<RegistryBundleNameInput> {
  return {
    name: "list_registry_bundle_versions",
    description: "List every published version of a given bundle name in a Claws registry, most recent first.",
    riskLevel: "safe",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        branch: { type: "string" },
        name: { type: "string" },
      },
      required: ["owner", "repo", "name"],
    },
    describeCall: (input) => `list versions of "${input.name}" published to ${input.owner}/${input.repo}`,
    async handler(input) {
      const result = await listRegistryBundleVersions(config, { owner: input.owner, repo: input.repo, branch: input.branch }, input.name, apiBaseUrl);
      if (!result.ok) return { content: result.error, isError: true };
      return { content: result.value.join("\n"), isError: false };
    },
  };
}

interface InstallBundleFromRegistryInput extends RegistryTargetInput {
  name: string;
  version?: string;
}

export function createInstallBundleFromRegistryTool(config: ClawsRegistryConfig, apiBaseUrl?: string): ToolDefinition<InstallBundleFromRegistryInput> {
  return {
    name: "install_bundle_from_registry",
    description:
      "Fetch a bundle from a Claws registry (a GitHub repo — see publish_bundle_to_registry) and install it into " +
      "this project, same as install_bundle — writes its files into `.finanfa-code/` and the project root, " +
      "OVERWRITING any existing file at the same path, snapshotted first so it can be undone (see " +
      "list_bundle_snapshots/rollback_bundle). Omit `version` for the highest published version. " +
      "IMPORTANT: a bundle's settings.json can include hooks — arbitrary shell commands that run automatically " +
      "once this project is trusted. A valid signature only proves the bundle wasn't tampered with in transit, " +
      "NOT that its content is safe — only install one from a source the user actually trusts, and confirm with " +
      "them first.",
    riskLevel: "dangerous",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        branch: { type: "string" },
        name: { type: "string" },
        version: { type: "string", description: "Omit for the highest published version" },
      },
      required: ["owner", "repo", "name"],
    },
    describeCall: (input) => `install bundle "${input.name}${input.version ? `@${input.version}` : ""}" from ${input.owner}/${input.repo}`,
    async handler(input, ctx) {
      const fetched = await fetchRegistryBundle(config, { owner: input.owner, repo: input.repo, branch: input.branch }, input.name, input.version, apiBaseUrl);
      if (!fetched.ok) return { content: fetched.error, isError: true };
      const bundle = fetched.value;

      const result = await installClawBundle(ctx.cwd, bundle);
      const signatureNote = !result.signatureStatus.signed
        ? "unsigned bundle — no publisher identity to verify"
        : !result.signatureStatus.valid
          ? "SIGNATURE DID NOT VERIFY — this bundle's content doesn't match its own signature (tampered, or corrupted in transit)"
          : `signature verified (publisher ${result.signatureStatus.fingerprint}${result.signatureStatus.knownPublisher ? ", a publisher this machine has seen before" : ", first time seeing this publisher"})`;
      const versionNote =
        result.versionChange === "new"
          ? "first time installing this bundle name here"
          : result.versionChange === "same"
            ? `reinstalling the same version (${result.previousVersion})`
            : result.versionChange === "upgrade"
              ? `upgrading from ${result.previousVersion} to ${bundle.manifest.version}`
              : `DOWNGRADING from ${result.previousVersion} to ${bundle.manifest.version}`;

      return {
        content:
          `Installed "${bundle.manifest.name}@${bundle.manifest.version}" from ${input.owner}/${input.repo} — ${result.filesWritten.length} file(s) written (${versionNote}). ${signatureNote}. ` +
          `Snapshot "${result.snapshotId}" saved beforehand — use rollback_bundle to undo.`,
        isError: false,
      };
    },
  };
}
