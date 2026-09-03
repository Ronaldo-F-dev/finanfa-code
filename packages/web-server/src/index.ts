import { createServer } from "node:http";
import path from "node:path";
import express from "express";
import { WebSocketServer, type WebSocket } from "ws";
import { AgentSession } from "@finanfa/core/src/core/session.js";
import { runTurn } from "@finanfa/core/src/core/loop.js";
import { ToolRegistry } from "@finanfa/core/src/tools/registry.js";
import { registerBuiltins, registerStatefulBuiltins } from "@finanfa/core/src/tools/builtin/index.js";
import { PermissionManager } from "@finanfa/core/src/permissions/manager.js";
import { loadPermissionConfig } from "@finanfa/core/src/permissions/config.js";
import { McpClientManager } from "@finanfa/core/src/mcp/client-manager.js";
import { loadSkills, formatSkillIndex, createReadSkillTool } from "@finanfa/core/src/skills/loader.js";
import { loadMemories, formatMemoryIndex, createReadMemoryTool, writeMemoryTool } from "@finanfa/core/src/memory/loader.js";
import { loadProjectInstructions, formatProjectInstructions } from "@finanfa/core/src/core/project-instructions.js";
import { loadDesignContract } from "@finanfa/core/src/core/design-contract.js";
import { BrowserManager } from "@finanfa/core/src/browser/manager.js";
import { loadConfig } from "@finanfa/core/src/core/config.js";
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
  const requestedModel = new URL(url, "http://localhost").searchParams.get("model") ?? undefined;

  try {
    const config = await loadConfig(CWD);
    const { provider, defaultModel, kind: providerKind } = selectProvider(config);
    const model = requestedModel ?? defaultModel;

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

    const session = new AgentSession({ cwd: CWD, model, systemPrompt });

    const permissionConfig = await loadPermissionConfig(CWD);
    const permissions = new PermissionManager({ config: permissionConfig, ui: adapter });

    const mcp = new McpClientManager();
    const browser = new BrowserManager();
    await connectMcpServers(CWD, mcp, adapter);
    for (const def of await mcp.listAllTools()) tools.register(def);

    registerStatefulBuiltins(tools, { provider, permissions, ui: adapter, model, cwd: CWD, browser, designContract: designContract.content });

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
