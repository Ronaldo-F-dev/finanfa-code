import { restorePointsByClientId, truncateBeforeUserMessage } from "../rewind";
import { useCallback, useEffect, useRef, useState } from "react";

export type ToolRiskLevel = "safe" | "ask" | "dangerous";

export type TimelineItem =
  | { kind: "user"; id: string; text: string; images?: Attachment[]; /** Sent with the message so the server can tie its restore point to it. Absent on messages replayed from a saved session, which have none. */ clientId?: string }
  | { kind: "assistant"; id: string; text: string; streaming: boolean }
  | { kind: "thinking"; id: string; text: string; streaming: boolean }
  | { kind: "log"; id: string; variant: "system" | "error"; text: string }
  | {
      kind: "tool_call";
      id: string;
      toolCallId: string;
      toolName: string;
      description: string;
      riskLevel: ToolRiskLevel;
      /** Filled in once the matching "tool_result" message arrives (by toolCallId) — undefined while the call is still running. Same shape as the VS Code webview's TimelineItem. */
      result?: { isError: boolean; content: string };
    }
  | { kind: "media"; id: string; mediaKind: "audio" | "image"; path: string; mimeType: string };

/** Before/after contents of the file a tool is about to change — present for edits, so the approval can show a real diff. */
export interface FilePreview {
  path: string;
  before: string;
  after: string;
}

/** Which groups of tool calls are approved without asking, as the server reports them. */
export interface ApprovalSettings {
  /** category -> approved without asking. A missing category is "ask". */
  settings: Record<string, boolean>;
  /** An administrator's policy forbids skipping approvals: the switches are locked. */
  forbidden: boolean;
  /** Every category the server knows, in display order. */
  categories: string[];
}

export interface PermissionRequest {
  requestId: number;
  prompt: string;
  filePreview?: FilePreview;
}

export interface StatusInfo {
  tokens: number;
  costUsd: number;
  model: string;
  planMode?: boolean;
}

export interface SessionInfo {
  id: string;
  title?: string;
  model: string;
  providerKind: string;
  toolCount: number;
  effort?: string;
}

export interface EffortNeedsDownload {
  level: string;
  ollamaModel: string;
}

export interface ToolStatus {
  name: string;
  riskLevel: ToolRiskLevel;
  enabled: boolean;
}

export interface McpServerStatus {
  name: string;
  transport: string;
  connected: boolean;
  disabled: boolean;
  needsAuth: boolean;
  /** Already in this project's .finanfa-code/mcp.json, vs. shown from the built-in catalog and not yet added. */
  inProject: boolean;
}

export interface ModelUnavailable {
  model: string;
  family: string;
  message: string;
}

export interface Attachment {
  mimeType: string;
  base64: string;
}

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  content: string;
  status: TodoStatus;
}

let nextId = 1;
const uid = () => String(nextId++);

/**
 * model is the model to use for a brand-new session; sessionId, when set,
 * resumes an existing one instead (the server ignores model in that case —
 * AgentSession.model is readonly, so a resumed session keeps whatever model
 * it was created with). onTitled fires once per session the first time the
 * server auto-generates a title, so the sidebar can refresh without polling.
 */
export function useAgentSocket(
  model: string | undefined,
  sessionId: string | undefined,
  projectId: string | undefined,
  onTitled?: () => void,
  /** Called after the server restored an earlier message: `text` is that message, so the composer can offer it again. */
  onRewound?: (info: { text?: string; preview: string; revertedFiles: number }) => void,
) {
  const [connected, setConnected] = useState(false);
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [busy, setBusy] = useState<{ active: boolean; label?: string }>({ active: false });
  const [permissionRequest, setPermissionRequest] = useState<PermissionRequest | null>(null);
  const [status, setStatus] = useState<StatusInfo | null>(null);
  const [sessionInfo, setSessionInfo] = useState<SessionInfo | null>(null);
  const [mcpServers, setMcpServers] = useState<McpServerStatus[]>([]);
  // The very first mcp_status can take several real seconds — connecting to
  // each configured server is a real network/docker call, done sequentially
  // at startup (see connectMcpServers). Distinguishes "still connecting"
  // from "genuinely nothing configured" so the panel doesn't flash a wrong
  // "no servers" message to someone who opens it quickly.
  const [mcpLoaded, setMcpLoaded] = useState(false);
  const [toolsStatus, setToolsStatus] = useState<ToolStatus[]>([]);
  const [modelUnavailable, setModelUnavailable] = useState<ModelUnavailable | null>(null);
  const [effortNeedsDownload, setEffortNeedsDownload] = useState<EffortNeedsDownload | null>(null);
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [resumeToken, setResumeToken] = useState(0);
  const [approvals, setApprovals] = useState<ApprovalSettings>({ settings: {}, forbidden: false, categories: [] });
  // clientId of a user message -> the server's restore point number for it. Server-side these live in memory only,
  // so they cover the messages sent since this connection opened (not ones replayed from a saved session).
  const [restorePoints, setRestorePoints] = useState<Map<string, number>>(new Map());
  // The latest timeline, readable from the socket handler (which closes over the first render's state).
  const timelineRef = useRef<TimelineItem[]>(timeline);
  timelineRef.current = timeline;
  const wsRef = useRef<WebSocket | null>(null);
  const streamingIdRef = useRef<string | null>(null);
  // Same "one open block at a time" bookkeeping as streamingIdRef, for the
  // reasoning block that streams before the reply (writeThinkingDelta).
  const thinkingIdRef = useRef<string | null>(null);
  const onTitledRef = useRef(onTitled);
  onTitledRef.current = onTitled;
  const onRewoundRef = useRef(onRewound);
  onRewoundRef.current = onRewound;
  // Whether *this* connection's session already had a title as of its last
  // session_info — reset per connection, used only to tell "just got its
  // first auto-generated title" apart from "echoing the same title back".
  const hadTitleRef = useRef(false);

  useEffect(() => {
    if (!model) return;
    setTimeline([]);
    setRestorePoints(new Map());
    setStatus(null);
    setBusy({ active: false });
    setPermissionRequest(null);
    setSessionInfo(null);
    setMcpServers([]);
    setMcpLoaded(false);
    setModelUnavailable(null);
    setTodos([]);
    streamingIdRef.current = null;
    thinkingIdRef.current = null;
    hadTitleRef.current = false;
    setConnected(false);

    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const qs = new URLSearchParams({ model });
    if (sessionId) qs.set("session", sessionId);
    if (projectId) qs.set("project", projectId);
    const ws = new WebSocket(`${proto}//${location.host}/ws?${qs.toString()}`);
    wsRef.current = ws;

    // "Connected" means the server is actually ready to run a turn, not
    // merely that the WebSocket handshake finished: buildTurnContext takes
    // seconds (config, tool registration, MCP), and the composer used to
    // enable in that window — a fast first message then raced the server's
    // handler (queued server-side now, see index.ts's early-message queue,
    // but the UI shouldn't invite the race either). session_info is the
    // server's own ready signal. A project's queued first message in
    // App.tsx keys off this same flag and needs the truthful one.
    ws.onclose = () => setConnected(false);

    // Closes the currently-open reasoning block, if any. Thinking always
    // precedes the reply (or an error/end), and a block left "streaming"
    // forever would keep its live indicator on and look stuck.
    const endThinking = (): void => {
      const id = thinkingIdRef.current;
      if (!id) return;
      thinkingIdRef.current = null;
      setTimeline((t) => t.map((item) => (item.kind === "thinking" && item.id === id ? { ...item, streaming: false } : item)));
    };

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data as string);
      switch (msg.type) {
        case "assistant_delta": {
          endThinking();
          if (!streamingIdRef.current) {
            const id = uid();
            streamingIdRef.current = id;
            setTimeline((t) => [...t, { kind: "assistant", id, text: msg.text, streaming: true }]);
          } else {
            const id = streamingIdRef.current;
            setTimeline((t) => t.map((item) => (item.kind === "assistant" && item.id === id ? { ...item, text: item.text + msg.text } : item)));
          }
          break;
        }
        case "assistant_end": {
          endThinking();
          const id = streamingIdRef.current;
          streamingIdRef.current = null;
          if (id) setTimeline((t) => t.map((item) => (item.kind === "assistant" && item.id === id ? { ...item, streaming: false } : item)));
          break;
        }
        case "thinking_delta": {
          if (!thinkingIdRef.current) {
            const id = uid();
            thinkingIdRef.current = id;
            setTimeline((t) => [...t, { kind: "thinking", id, text: msg.text, streaming: true }]);
          } else {
            const id = thinkingIdRef.current;
            setTimeline((t) => t.map((item) => (item.kind === "thinking" && item.id === id ? { ...item, text: item.text + msg.text } : item)));
          }
          break;
        }
        case "system":
          setTimeline((t) => [...t, { kind: "log", id: uid(), variant: "system", text: msg.text }]);
          break;
        case "error":
          endThinking();
          setTimeline((t) => [...t, { kind: "log", id: uid(), variant: "error", text: msg.text }]);
          break;
        case "tool_call":
          setTimeline((t) => [...t, { kind: "tool_call", id: uid(), toolCallId: msg.toolCallId, toolName: msg.toolName, description: msg.description, riskLevel: msg.riskLevel }]);
          break;
        case "tool_result":
          setTimeline((t) =>
            t.map((item) => (item.kind === "tool_call" && item.toolCallId === msg.toolCallId ? { ...item, result: { isError: msg.isError, content: msg.content } } : item)),
          );
          break;
        case "media":
          setTimeline((t) => [...t, { kind: "media", id: uid(), mediaKind: msg.kind, path: msg.path, mimeType: msg.mimeType }]);
          break;
        case "todos":
          setTodos(msg.todos);
          break;
        case "busy":
          setBusy({ active: msg.busy, label: msg.label });
          break;
        case "status":
          setStatus(msg.status);
          break;
        case "ask":
          setPermissionRequest({ requestId: msg.requestId, prompt: msg.prompt, filePreview: msg.filePreview });
          break;
        case "session_info": {
          setConnected(true);
          const wasTitled = hadTitleRef.current;
          hadTitleRef.current = Boolean(msg.title);
          setSessionInfo({ id: msg.id, title: msg.title, model: msg.model, providerKind: msg.providerKind, toolCount: msg.toolCount, effort: msg.effort });
          if (msg.title && !wasTitled) onTitledRef.current?.();
          break;
        }
        case "mcp_status":
          setMcpServers(msg.servers);
          setMcpLoaded(true);
          break;
        case "tools_status":
          setToolsStatus(msg.tools);
          break;
        case "model_unavailable":
          setModelUnavailable({ model: msg.model, family: msg.family, message: msg.message });
          break;
        case "effort_needs_download":
          setEffortNeedsDownload({ level: msg.level, ollamaModel: msg.ollamaModel });
          break;
        case "auto_approve":
          setApprovals({ settings: msg.settings ?? {}, forbidden: Boolean(msg.forbidden), categories: Array.isArray(msg.categories) ? msg.categories : [] });
          break;
        case "checkpoints":
          setRestorePoints(restorePointsByClientId(msg.checkpoints));
          break;
        case "rewound": {
          const { timeline: kept, text } = typeof msg.clientId === "string" ? truncateBeforeUserMessage(timelineRef.current, msg.clientId) : { timeline: timelineRef.current, text: undefined };
          setTimeline(kept);
          onRewoundRef.current?.({ text, preview: msg.preview, revertedFiles: msg.revertedFiles });
          break;
        }
        case "history": {
          const items: TimelineItem[] = (msg.messages as { role: "user" | "assistant" | "error"; content: string }[]).map((m) =>
            m.role === "error"
              ? { kind: "log", id: uid(), variant: "error", text: m.content }
              : ({ kind: m.role, id: uid(), text: m.content, ...(m.role === "assistant" ? { streaming: false } : {}) } as TimelineItem),
          );
          // Normally prepended (a resumed session's past turns, arriving
          // before anything else). After /compact (or the web UI's Compact
          // button) the server sends replace: true instead — session.messages
          // was just collapsed to a two-message summary server-side, and the
          // timeline needs to match that exactly, not keep the old turns
          // alongside it.
          setTimeline((t) => (msg.replace ? items : [...items, ...t]));
          break;
        }
        default:
          break;
      }
    };

    return () => ws.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, sessionId, projectId, resumeToken]);

  const sendMessage = useCallback((text: string, images?: Attachment[], deepResearch?: boolean) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const clientId = uid();
    setTimeline((t) => [...t, { kind: "user", id: uid(), text, images, clientId }]);
    ws.send(JSON.stringify({ type: "user_message", text, images, deepResearch, clientId }));
  }, []);

  const answerPermission = useCallback((requestId: number, answer: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "permission_response", requestId, answer }));
    setPermissionRequest((current) => (current?.requestId === requestId ? null : current));
  }, []);

  const interrupt = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "interrupt" }));
  }, []);

  const reconnect = useCallback(() => setResumeToken((k) => k + 1), []);

  const switchModel = useCallback((newModel: string, family: string, baseUrl?: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "set_model", model: newModel, family, baseUrl }));
  }, []);

  const dismissModelUnavailable = useCallback(() => setModelUnavailable(null), []);
  const dismissEffortNeedsDownload = useCallback(() => setEffortNeedsDownload(null), []);

  const send = useCallback((payload: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(payload));
  }, []);
  const mcpConnect = useCallback((name: string) => send({ type: "mcp_connect", name }), [send]);
  const mcpToggle = useCallback((name: string, enabled: boolean) => send({ type: enabled ? "mcp_enable" : "mcp_disable", name }), [send]);
  const mcpReload = useCallback(() => send({ type: "mcp_reload" }), [send]);
  const setToolEnabled = useCallback((name: string, enabled: boolean) => send({ type: "set_tool_enabled", name, enabled }), [send]);
  const setEffort = useCallback((level: string) => send({ type: "set_effort", level }), [send]);
  const requestToolsStatus = useCallback(() => send({ type: "tools_status" }), [send]);
  const compact = useCallback(() => send({ type: "compact" }), [send]);
  const rewind = useCallback((checkpoint: number) => send({ type: "rewind", checkpoint }), [send]);
  const setAutoApprove = useCallback((category: string, enabled: boolean) => send({ type: "set_auto_approve", category, enabled }), [send]);
  /** Appends a note to the conversation view that only this browser shows (nothing is sent to the agent). */
  const addNote = useCallback((variant: "system" | "error", text: string) => setTimeline((t) => [...t, { kind: "log", id: uid(), variant, text }]), []);
  const setPlanMode = useCallback((enabled: boolean) => send({ type: "set_plan_mode", enabled }), [send]);

  return {
    connected,
    timeline,
    busy,
    permissionRequest,
    status,
    sessionInfo,
    mcpServers,
    mcpLoaded,
    toolsStatus,
    modelUnavailable,
    effortNeedsDownload,
    todos,
    approvals,
    setAutoApprove,
    restorePoints,
    rewind,
    addNote,
    sendMessage,
    answerPermission,
    interrupt,
    compact,
    reconnect,
    switchModel,
    dismissModelUnavailable,
    dismissEffortNeedsDownload,
    mcpConnect,
    mcpToggle,
    mcpReload,
    setToolEnabled,
    requestToolsStatus,
    setPlanMode,
    setEffort,
  };
}
