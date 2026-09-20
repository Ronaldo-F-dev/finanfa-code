import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { ToolDefinition } from "../core/types.js";
import type { McpServerConfig } from "./config.js";
import { FileOAuthClientProvider, NeedsAuthorizationError } from "./oauth-provider.js";
import { retryWithBackoff } from "../util/retry.js";

export { NeedsAuthorizationError };

export const MCP_TOOL_PREFIX = "mcp__";

type RemoteTransport = StreamableHTTPClientTransport | SSEClientTransport;

function toolPrefix(serverName: string): string {
  return `${MCP_TOOL_PREFIX}${serverName}__`;
}

/** Extracts the server name from a namespaced MCP tool name (`mcp__github__list_issues` → `github`), or undefined for a non-MCP tool name. */
export function mcpToolServerName(toolName: string): string | undefined {
  if (!toolName.startsWith(MCP_TOOL_PREFIX)) return undefined;
  const rest = toolName.slice(MCP_TOOL_PREFIX.length);
  const separatorIndex = rest.indexOf("__");
  return separatorIndex === -1 ? undefined : rest.slice(0, separatorIndex);
}

interface BuiltTransport {
  transport: StdioClientTransport | RemoteTransport;
  authProvider?: FileOAuthClientProvider;
}

function buildTransport(cfg: McpServerConfig): BuiltTransport {
  if (cfg.transport === "stdio") {
    if (!cfg.command) throw new Error(`MCP server "${cfg.name}": stdio transport requires "command"`);
    return { transport: new StdioClientTransport({ command: cfg.command, args: cfg.args }) };
  }
  if (!cfg.url) throw new Error(`MCP server "${cfg.name}": ${cfg.transport} transport requires "url"`);
  const authProvider = new FileOAuthClientProvider(cfg.name);
  const transport =
    cfg.transport === "http"
      ? new StreamableHTTPClientTransport(new URL(cfg.url), { authProvider })
      : new SSEClientTransport(new URL(cfg.url), { authProvider });
  return { transport, authProvider };
}

export class McpClientManager {
  private readonly clients = new Map<string, Client>();

  /**
   * allowOAuthPrompt (default true): when false, never opens a browser or
   * blocks waiting for one — if the server has no saved token, throws
   * NeedsAuthorizationError immediately instead of attempting to connect.
   * This has to be enforced *on the provider itself* (via setSilent), not
   * just by a pre-check before calling client.connect(): the MCP SDK's own
   * internal auth() calls authProvider.redirectToAuthorization() (which
   * opens the browser) on *any* 401 it sees — not only during this
   * connect() call, but on every later tool call made through the client
   * this method returns, for as long as that process lives. A real,
   * reported bug: a saved-but-expired token (Vercel issues no
   * refresh_token, so its token dies within the hour) let a browser pop
   * open with literally nobody clicking anything, sometimes hours into an
   * unrelated conversation, because only the "no token at all" case was
   * ever guarded here. Every provider this method hands to a Client is
   * silenced the moment that Client is safely connected — regardless of
   * whether *this* connect() was itself interactive — so only a fresh,
   * explicit reconnect (which builds a brand new provider, silent again
   * only for its own attempt) can ever open a browser after that.
   */
  async connect(cfg: McpServerConfig, opts: { allowOAuthPrompt?: boolean } = {}): Promise<void> {
    const allowOAuthPrompt = opts.allowOAuthPrompt ?? true;

    // A real, reported bug: retryWithBackoff previously retried
    // `client.connect(transport)` on the SAME client+transport pair. The
    // SDK's Client.connect() records the transport as soon as it starts
    // (before the initialize handshake finishes), so if attempt 1 fails
    // *after* that point — a slow remote MCP server timing out its first
    // request, for instance — attempt 2 no longer sees the original
    // failure: it hits the SDK's own "Already connected to a transport"
    // guard instead, since `_transport` was never cleared. A fresh Client
    // and transport per attempt (built inside the retried closure) makes
    // every retry a genuinely clean one, and is why lastTransport/
    // lastAuthProvider are captured here instead of built once up front.
    let client!: Client;
    let lastTransport!: StdioClientTransport | RemoteTransport;
    let lastAuthProvider: FileOAuthClientProvider | undefined;

    try {
      // Retries a transient connection failure (a stdio server process not
      // ready yet, a momentary network blip for a remote transport) — but
      // never retries UnauthorizedError/NeedsAuthorizationError, so the
      // OAuth flow below still triggers immediately instead of being
      // delayed behind backoff waits.
      await retryWithBackoff(
        async () => {
          const { transport, authProvider } = buildTransport(cfg);
          lastTransport = transport;
          lastAuthProvider = authProvider;
          // Silenced for the connect attempt itself whenever prompts are
          // disallowed — covers both "no token yet" and "token exists but
          // is expired/rejected", where the SDK's own auth() would
          // otherwise redirect straight from inside client.connect().
          authProvider?.setSilent(!allowOAuthPrompt);
          if (!allowOAuthPrompt && authProvider && !(await authProvider.tokens())) {
            throw new NeedsAuthorizationError(cfg.name);
          }
          client = new Client({ name: "finanfa-code", version: "0.1.0" }, { capabilities: {} });
          await client.connect(transport);
        },
        {
          attempts: 3,
          baseDelayMs: 500,
          shouldRetry: (err) => !(err instanceof UnauthorizedError) && !(err instanceof NeedsAuthorizationError),
        },
      );
    } catch (err) {
      if (err instanceof NeedsAuthorizationError) throw err;
      if (!(err instanceof UnauthorizedError) || !lastAuthProvider) throw err;
      // A saved token existed but was rejected (expired/revoked) — with
      // OAuth prompts disabled, surface that as NeedsAuthorizationError too
      // rather than opening a browser the caller didn't ask for.
      if (!allowOAuthPrompt) throw new NeedsAuthorizationError(cfg.name);

      // The transport's OAuthClientProvider already opened the browser (see
      // FileOAuthClientProvider.redirectToAuthorization) — wait for the
      // redirect and exchange the code. finishAuth() persists the tokens to
      // disk but does NOT reset the transport's own started state (its own
      // docstring: the exchange "enables the *next* connection attempt", not
      // a retry on this instance) — client.connect() calls transport.start()
      // internally, which throws "already started!" the second time. Build a
      // fresh transport instead of reusing the one that already ran; a new
      // FileOAuthClientProvider for the same server reads the
      // just-persisted tokens straight from disk, so nothing is lost.
      const code = await lastAuthProvider.waitForCallback();
      await (lastTransport as RemoteTransport).finishAuth(code);
      const { transport: freshTransport, authProvider: freshAuthProvider } = buildTransport(cfg);
      lastAuthProvider = freshAuthProvider;
      client = new Client({ name: "finanfa-code", version: "0.1.0" }, { capabilities: {} });
      await client.connect(freshTransport);
    }

    // Connected — from here on, a 401 the SDK sees on some later, unrelated
    // tool call must never pop a browser unprompted. Only a fresh call to
    // connect() (a new provider, briefly un-silenced for its own attempt
    // above) gets to do that again.
    lastAuthProvider?.setSilent(true);
    this.clients.set(cfg.name, client);
  }

  async disconnectAll(): Promise<void> {
    for (const client of this.clients.values()) {
      await client.close();
    }
    this.clients.clear();
  }

  connectedServers(): string[] {
    return [...this.clients.keys()];
  }

  /** Lists tools from every connected server, wrapped as ToolDefinitions namespaced by server name. */
  async listAllTools(): Promise<ToolDefinition[]> {
    const definitions: ToolDefinition[] = [];

    for (const [serverName, client] of this.clients) {
      const { tools } = await client.listTools();
      for (const tool of tools) {
        definitions.push(this.wrapTool(serverName, client, tool));
      }
    }

    return definitions;
  }

  private wrapTool(
    serverName: string,
    client: Client,
    tool: { name: string; description?: string; inputSchema: Record<string, unknown> },
  ): ToolDefinition {
    const name = `${toolPrefix(serverName)}${tool.name}`;

    return {
      name,
      description: tool.description ?? `Tool "${tool.name}" from MCP server "${serverName}"`,
      inputSchema: tool.inputSchema as ToolDefinition["inputSchema"],
      riskLevel: "ask", // external/unknown code: never trust an MCP tool by default
      describeCall: (input) => `${serverName}.${tool.name} ${JSON.stringify(input)}`,
      async handler(input) {
        const result = await client.callTool({ name: tool.name, arguments: input as Record<string, unknown> });
        const content = Array.isArray(result.content)
          ? result.content
              .map((block) => (block.type === "text" ? block.text : `[${block.type} content]`))
              .join("\n")
          : String(result.content ?? "");
        return { content, isError: Boolean(result.isError) };
      },
    };
  }
}
