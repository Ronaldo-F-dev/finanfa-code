import { createServer } from "node:http";
import path from "node:path";
import express from "express";
import { WebSocketServer, type WebSocket } from "ws";
import { AgentSession } from "@finanfa/core/src/core/session.js";
import { runTurn, maybeGenerateTitle } from "@finanfa/core/src/core/loop.js";
import { ToolRegistry } from "@finanfa/core/src/tools/registry.js";
import { registerBuiltins, registerStatefulBuiltins } from "@finanfa/core/src/tools/builtin/index.js";
import { PermissionManager } from "@finanfa/core/src/permissions/manager.js";
import { loadPermissionConfig } from "@finanfa/core/src/permissions/config.js";
import { McpClientManager, MCP_TOOL_PREFIX } from "@finanfa/core/src/mcp/client-manager.js";
import { loadMcpServers } from "@finanfa/core/src/mcp/config.js";
import { loadSkills, formatSkillIndex, createReadSkillTool } from "@finanfa/core/src/skills/loader.js";
import { loadMemories, formatMemoryIndex, createReadMemoryTool, writeMemoryTool } from "@finanfa/core/src/memory/loader.js";
import { loadProjectInstructions, formatProjectInstructions } from "@finanfa/core/src/core/project-instructions.js";
import { loadDesignContract } from "@finanfa/core/src/core/design-contract.js";
import { BrowserManager } from "@finanfa/core/src/browser/manager.js";
import { loadConfig, saveGlobalConfig, type FinanfaConfig } from "@finanfa/core/src/core/config.js";
import { CONFIG_KEYS, SECRET_KEYS, maskSecret } from "@finanfa/core/src/commands/builtin.js";
import { BASE_SYSTEM_PROMPT, selectProvider, connectMcpServers } from "@finanfa/core/src/app.js";
import { PRICING } from "@finanfa/core/src/core/pricing.js";
import { createWebUiAdapter } from "./web-ui-adapter.js";

// The project the agent operates on — same "cwd" concept as running the CLI
// from that directory. A single-project server for now: multi-project/
// multi-tenant would need a workspace picker and per-connection cwd, which
// is real added scope (auth, path isolation between users) left for later.
const CWD = process.env.FINANFA_WEB_CWD ?? process.cwd();
const PORT = Number(process.env.PORT ?? 4600);

const app = express();
app.use(express.json());

app.get("/api/models", async (_req, res) => {
  const config = await loadConfig(CWD);
  const { defaultModel, kind } = selectProvider(config);
  const models = kind === "anthropic" ? Object.keys(PRICING) : [defaultModel];
  res.json({ providerKind: kind, defaultModel, models });
});

app.get("/api/sessions", async (_req, res) => {
  const sessions = await AgentSession.list(CWD);
  res.json({ sessions: sessions.map((s) => ({ id: s.id, title: s.title, mtime: s.mtime })) });
});

app.delete("/api/sessions/:id", async (req, res) => {
  await AgentSession.delete(CWD, req.params.id);
  res.json({ ok: true });
});

// Same scope as the CLI's /config command: reads the merged (global +
// project) config, but only ever writes the global file — a web session has
// no separate notion of "project-local" beyond CWD itself. Secrets
// (apiKey/visionApiKey) are masked on the way out (never round-tripped in
// full to the browser) — a field is left untouched on save unless the
// request explicitly includes it.
app.get("/api/config", async (_req, res) => {
  const config = await loadConfig(CWD);
  const masked: Record<string, string | undefined> = {};
  for (const key of CONFIG_KEYS) {
    const value = config[key];
    masked[key] = value && (SECRET_KEYS as readonly string[]).includes(key) ? maskSecret(value) : value;
  }
  res.json({ config: masked, secretKeys: SECRET_KEYS });
});

app.post("/api/config", async (req, res) => {
  const body = req.body as Partial<FinanfaConfig>;
  const current = await loadConfig(CWD);
  const next: FinanfaConfig = { ...current };
  for (const key of CONFIG_KEYS) {
    if (!(key in body)) continue;
    const value = body[key];
    // An empty string clears the field (matches /config's "unset by leaving
    // blank" convention); undefined/missing means "leave unchanged".
    if (value === "" || value === undefined) delete next[key];
    else (next as Record<string, unknown>)[key] = value;
  }
  await saveGlobalConfig(next);
  res.json({ ok: true, note: "Saved. Existing open chats keep their current provider/model — start a new chat to pick up the change." });
});

const clientDist = path.join(import.meta.dirname, "../../web-client/dist");
app.use(express.static(clientDist));
app.get(/^(?!\/api|\/ws).*/, (_req, res) => {
  res.sendFile(path.join(clientDist, "index.html"), (err) => {
    if (err) res.status(404).send("finanfa-code-web: run `npm run build -w @finanfa/web-client` first, or use its dev server directly.");
  });
});

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

wss.on("connection", (ws: WebSocket, req) => {
  void handleConnection(ws, req.url ?? "");
});

async function handleConnection(ws: WebSocket, url: string): Promise<void> {
  const { adapter, resolvePending } = createWebUiAdapter(ws);
  const params = new URL(url, "http://localhost").searchParams;
  const requestedModel = params.get("model") ?? undefined;
  const requestedSessionId = params.get("session") ?? undefined;

  try {
    const config = await loadConfig(CWD);
    const { provider, defaultModel, kind: providerKind } = selectProvider(config);

    const tools = new ToolRegistry();
    registerBuiltins(tools);

    const skills = await loadSkills(CWD);
    if (skills.length > 0) tools.register(createReadSkillTool(skills));
    tools.register(writeMemoryTool);
    const memories = await loadMemories(CWD);
    if (memories.length > 0) tools.register(createReadMemoryTool(CWD));

    const projectInstructions = await loadProjectInstructions(CWD);
    const designContract = await loadDesignContract(CWD);
    const systemPrompt =
      BASE_SYSTEM_PROMPT + formatSkillIndex(skills) + formatMemoryIndex(memories) + formatProjectInstructions(projectInstructions);

    // The session's own (readonly) model wins on resume — a saved session
    // keeps whatever model it was created with, same as the CLI has no
    // /model command to change one mid-session either.
    let session: AgentSession;
    if (requestedSessionId) {
      try {
        session = await AgentSession.resume(CWD, requestedSessionId, systemPrompt);
      } catch (err) {
        adapter.writeError(
          `Could not resume session "${requestedSessionId}": ${err instanceof Error ? err.message : String(err)}. Starting a new session instead.`,
        );
        session = new AgentSession({ cwd: CWD, model: requestedModel ?? defaultModel, systemPrompt });
      }
    } else {
      session = new AgentSession({ cwd: CWD, model: requestedModel ?? defaultModel, systemPrompt });
    }
    const model = session.model;

    const permissionConfig = await loadPermissionConfig(CWD);
    const permissions = new PermissionManager({ config: permissionConfig, ui: adapter });

    const mcp = new McpClientManager();
    const browser = new BrowserManager();
    const { needsAuth } = await connectMcpServers(CWD, mcp, adapter);
    const needsAuthSet = new Set(needsAuth);
    for (const def of await mcp.listAllTools()) tools.register(def);

    registerStatefulBuiltins(tools, { provider, permissions, ui: adapter, model, cwd: CWD, browser, designContract: designContract.content });

    function sendSessionInfo(): void {
      ws.send(
        JSON.stringify({
          type: "session_info",
          id: session.id,
          title: session.title,
          model: session.model,
          providerKind,
          toolCount: tools.list().length,
        }),
      );
    }

    async function sendMcpStatus(): Promise<void> {
      const configured = await loadMcpServers(CWD);
      const connected = new Set(mcp.connectedServers());
      ws.send(
        JSON.stringify({
          type: "mcp_status",
          servers: configured.map((s) => ({
            name: s.name,
            transport: s.transport,
            connected: connected.has(s.name),
            disabled: session.disabledMcpServers.has(s.name),
            needsAuth: needsAuthSet.has(s.name),
          })),
        }),
      );
    }

    async function reloadMcpTools(): Promise<void> {
      tools.unregisterByPrefix(MCP_TOOL_PREFIX);
      for (const def of await mcp.listAllTools()) tools.register(def);
    }

    // Sent as a structured event (not just parsed out of the text banner
    // below) so the client can sync its model selector / title state
    // exactly, including when a resumed session's model differs from
    // whatever was last selected in the UI.
    sendSessionInfo();
    void sendMcpStatus();
    // Replay past turns for a resumed session — tool activity itself isn't
    // replayed (it isn't stored as display-ready text), only the user/
    // assistant exchange, same as reopening a ChatGPT/Claude.ai thread.
    if (requestedSessionId && session.messages.length > 0) {
      ws.send(
        JSON.stringify({
          type: "history",
          messages: session.messages
            .filter((m) => m.role === "user" || m.role === "assistant")
            .map((m) => ({ role: m.role, content: m.content })),
        }),
      );
    }

    adapter.writeBanner("0.1.0");
    adapter.writeSystem(`session ${session.id} · ${session.model} via ${providerKind} · ${tools.list().length} tools loaded`);
    if (mcp.connectedServers().length > 0) adapter.writeSystem(`MCP servers: ${mcp.connectedServers().join(", ")}`);

    let turnInFlight = false;

    ws.on("message", (raw: Buffer) => {
      void (async () => {
        let msg: { type: string; [key: string]: unknown };
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          adapter.writeError("Received a malformed message (not valid JSON).");
          return;
        }

        if (msg.type === "user_message" && typeof msg.text === "string") {
          if (turnInFlight) {
            adapter.writeError("A turn is already in progress — wait for it to finish (or interrupt) before sending another message.");
            return;
          }
          turnInFlight = true;
          try {
            await runTurn(session, provider, adapter, tools, permissions, msg.text);
            const hadTitle = Boolean(session.title);
            await maybeGenerateTitle(session, provider);
            if (!hadTitle && session.title) sendSessionInfo();
          } catch (err) {
            adapter.writeError(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
          } finally {
            turnInFlight = false;
            await session.persist().catch((err) => adapter.writeError(`Failed to save session: ${err instanceof Error ? err.message : err}`));
          }
        } else if (msg.type === "permission_response" && typeof msg.requestId === "number" && typeof msg.answer === "string") {
          resolvePending(msg.requestId, msg.answer);
        } else if (msg.type === "interrupt") {
          for (const controller of session.activeAbortControllers) controller.abort();
        } else if (msg.type === "set_model" && typeof msg.model === "string" && msg.model) {
          session.model = msg.model;
          sendSessionInfo();
        } else if (msg.type === "mcp_status") {
          await sendMcpStatus();
        } else if (msg.type === "mcp_connect" && typeof msg.name === "string") {
          const config = (await loadMcpServers(CWD)).find((s) => s.name === msg.name);
          if (!config) {
            adapter.writeError(`No MCP server named "${msg.name}" in .finanfa-code/mcp.json.`);
          } else if (mcp.connectedServers().includes(msg.name)) {
            adapter.writeSystem(`"${msg.name}" is already connected.`);
          } else {
            if (config.transport !== "stdio") adapter.writeSystem(`Connecting to "${msg.name}" — if it requires authorization, a browser tab will open on the server...`);
            try {
              await mcp.connect(config);
              needsAuthSet.delete(msg.name);
              await reloadMcpTools();
              adapter.writeSystem(`Connected "${msg.name}".`);
            } catch (err) {
              adapter.writeError(`Failed to connect "${msg.name}": ${err instanceof Error ? err.message : err}`);
            }
          }
          await sendMcpStatus();
        } else if ((msg.type === "mcp_enable" || msg.type === "mcp_disable") && typeof msg.name === "string") {
          if (!mcp.connectedServers().includes(msg.name)) {
            adapter.writeError(`No connected MCP server named "${msg.name}".`);
          } else if (msg.type === "mcp_enable") {
            session.disabledMcpServers.delete(msg.name);
          } else {
            session.disabledMcpServers.add(msg.name);
          }
          await sendMcpStatus();
        } else if (msg.type === "mcp_reload") {
          await reloadMcpTools();
          adapter.writeSystem("MCP tools reloaded.");
          await sendMcpStatus();
        }
      })();
    });

    ws.on("close", () => {
      void (async () => {
        for (const controller of session.activeAbortControllers) controller.abort();
        await session.persist().catch(() => {});
        await mcp.disconnectAll().catch(() => {});
        await browser.close().catch(() => {});
      })();
    });
  } catch (err) {
    adapter.writeError(`Failed to start session: ${err instanceof Error ? err.message : String(err)}`);
    ws.close();
  }
}

httpServer.listen(PORT, () => {
  console.log(`finanfa-code-web server listening on http://localhost:${PORT} (project: ${CWD})`);
});
