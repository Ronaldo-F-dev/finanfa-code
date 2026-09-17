import type { ToolDefinition } from "../../core/types.js";
import { registerRemoteHost, removeRemoteHost, loadRemoteHosts, checkAndRecordRemoteHostHealth } from "../../core/remote-hosts.js";

export interface RemoteHostsToolOptions {
  /** Overrides the real `ssh` binary — tests point this at a fake stand-in script, same pattern as run_remote_command. */
  binary?: string;
}

interface RegisterRemoteHostInput {
  alias: string;
  host: string;
  user?: string;
  port?: number;
  identity_file?: string;
}

export function createRegisterRemoteHostTool(): ToolDefinition<RegisterRemoteHostInput> {
  return {
    name: "register_remote_host",
    description:
      "Add (or update) a named remote machine in this project's known-hosts registry, so it shows up in " +
      "list_remote_hosts and can be health-checked without re-typing its connection details every time. " +
      "Doesn't itself connect to anything — auth/keys/known_hosts still come from the user's own real SSH setup.",
    riskLevel: "ask",
    inputSchema: {
      type: "object",
      properties: {
        alias: { type: "string", description: 'A short name to refer to this host by, e.g. "prod-db"' },
        host: { type: "string", description: "Hostname, IP, or an alias from ~/.ssh/config" },
        user: { type: "string" },
        port: { type: "number" },
        identity_file: { type: "string" },
      },
      required: ["alias", "host"],
    },
    describeCall: (input) => `register remote host "${input.alias}" (${input.host})`,
    async handler(input) {
      await registerRemoteHost({ alias: input.alias, host: input.host, user: input.user, port: input.port, identityFile: input.identity_file });
      return { content: `Registered remote host "${input.alias}".`, isError: false };
    },
  };
}

interface RemoteHostAliasInput {
  alias: string;
}

export function createRemoveRemoteHostTool(): ToolDefinition<RemoteHostAliasInput> {
  return {
    name: "remove_remote_host",
    description: "Remove a host from the known-hosts registry (see register_remote_host). Doesn't affect anything on the remote machine itself.",
    riskLevel: "ask",
    inputSchema: { type: "object", properties: { alias: { type: "string" } }, required: ["alias"] },
    describeCall: (input) => `remove remote host "${input.alias}"`,
    async handler(input) {
      const removed = await removeRemoteHost(input.alias);
      if (!removed) return { content: `No registered remote host named "${input.alias}".`, isError: true };
      return { content: `Removed remote host "${input.alias}".`, isError: false };
    },
  };
}

export function createListRemoteHostsTool(): ToolDefinition<Record<string, never>> {
  return {
    name: "list_remote_hosts",
    description: "List every registered remote host, with its last-known health status (see check_remote_host_health) — not re-checked live on every call.",
    riskLevel: "safe",
    inputSchema: { type: "object", properties: {} },
    async handler() {
      const registry = await loadRemoteHosts();
      const entries = Object.values(registry);
      if (entries.length === 0) return { content: "No remote hosts registered.", isError: false };
      return {
        content: entries
          .map((e) => {
            const target = `${e.user ? `${e.user}@` : ""}${e.host}`;
            const health = e.lastCheckedAt ? `${e.lastHealthy ? "healthy" : "UNREACHABLE"} as of ${e.lastCheckedAt}` : "never checked";
            return `${e.alias} (${target}): ${health}`;
          })
          .join("\n"),
        isError: false,
      };
    },
  };
}

export function createCheckRemoteHostHealthTool(options: RemoteHostsToolOptions = {}): ToolDefinition<RemoteHostAliasInput> {
  const binary = options.binary ?? "ssh";
  return {
    name: "check_remote_host_health",
    description:
      "Runs a real, read-only health probe (uptime + disk usage) on a registered remote host over SSH, and " +
      "records the outcome for list_remote_hosts. A failure means the host is genuinely unreachable right now " +
      "(or SSH auth failed) — not necessarily that anything is wrong with it.",
    riskLevel: "safe",
    inputSchema: { type: "object", properties: { alias: { type: "string" } }, required: ["alias"] },
    describeCall: (input) => `check health of remote host "${input.alias}"`,
    async handler(input) {
      const result = await checkAndRecordRemoteHostHealth(input.alias, undefined, binary);
      if (!result) return { content: `No registered remote host named "${input.alias}" — see register_remote_host.`, isError: true };
      if (!result.healthy) return { content: `"${input.alias}" is unreachable: ${result.summary}`, isError: true };
      return { content: `"${input.alias}" is healthy:\n${result.summary}`, isError: false };
    },
  };
}
