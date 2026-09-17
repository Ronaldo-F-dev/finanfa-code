import { useCallback, useEffect, useRef, useState } from "react";

export type ToolRiskLevel = "safe" | "ask" | "dangerous";

export type TimelineItem =
  | { kind: "user"; id: string; text: string; images?: Attachment[] }
  | { kind: "assistant"; id: string; text: string; streaming: boolean }
  | { kind: "log"; id: string; variant: "system" | "error"; text: string }
  | { kind: "tool_call"; id: string; toolName: string; description: string; riskLevel: ToolRiskLevel }
  | { kind: "media"; id: string; mediaKind: "audio" | "image"; path: string; mimeType: string };

export interface PermissionRequest {
  requestId: number;
  prompt: string;
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
  const wsRef = useRef<WebSocket | null>(null);
  const streamingIdRef = useRef<string | null>(null);
  const onTitledRef = useRef(onTitled);
  onTitledRef.current = onTitled;
  // Whether *this* connection's session already had a title as of its last
  // session_info — reset per connection, used only to tell "just got its
  // first auto-generated title" apart from "echoing the same title back".
  const hadTitleRef = useRef(false);

  useEffect(() => {
    if (!model) return;
    setTimeline([]);
    setStatus(null);
    setBusy({ active: false });
    setPermissionRequest(null);
    setSessionInfo(null);
    setMcpServers([]);
    setMcpLoaded(false);
    setModelUnavailable(null);
    setTodos([]);
    streamingIdRef.current = null;
    hadTitleRef.current = false;

    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const qs = new URLSearchParams({ model });
    if (sessionId) qs.set("session", sessionId);
    if (projectId) qs.set("project", projectId);
    const ws = new WebSocket(`${proto}//${location.host}/ws?${qs.toString()}`);
    wsRef.current = ws;

    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data as string);
      switch (msg.type) {
        case "assistant_delta": {
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
          const id = streamingIdRef.current;
          streamingIdRef.current = null;
          if (id) setTimeline((t) => t.map((item) => (item.kind === "assistant" && item.id === id ? { ...item, streaming: false } : item)));
          break;
        }
        case "system":
          setTimeline((t) => [...t, { kind: "log", id: uid(), variant: "system", text: msg.text }]);
          break;
        case "error":
          setTimeline((t) => [...t, { kind: "log", id: uid(), variant: "error", text: msg.text }]);
          break;
        case "tool_call":
          setTimeline((t) => [...t, { kind: "tool_call", id: uid(), toolName: msg.toolName, description: msg.description, riskLevel: msg.riskLevel }]);
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
          setPermissionRequest({ requestId: msg.requestId, prompt: msg.prompt });
          break;
        case "session_info": {
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
    setTimeline((t) => [...t, { kind: "user", id: uid(), text, images }]);
    ws.send(JSON.stringify({ type: "user_message", text, images, deepResearch }));
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
