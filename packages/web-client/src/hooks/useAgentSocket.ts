import { useCallback, useEffect, useRef, useState } from "react";

export type TimelineItem =
  | { kind: "user"; id: string; text: string; images?: Attachment[] }
  | { kind: "assistant"; id: string; text: string; streaming: boolean }
  | { kind: "log"; id: string; variant: "system" | "error"; text: string };

export interface PermissionRequest {
  requestId: number;
  prompt: string;
}

export interface StatusInfo {
  tokens: number;
  costUsd: number;
  model: string;
}

export interface SessionInfo {
  id: string;
  title?: string;
  model: string;
  providerKind: string;
  toolCount: number;
}

export interface McpServerStatus {
  name: string;
  transport: string;
  connected: boolean;
  disabled: boolean;
  needsAuth: boolean;
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
  const [modelUnavailable, setModelUnavailable] = useState<ModelUnavailable | null>(null);
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
          setSessionInfo({ id: msg.id, title: msg.title, model: msg.model, providerKind: msg.providerKind, toolCount: msg.toolCount });
          if (msg.title && !wasTitled) onTitledRef.current?.();
          break;
        }
        case "mcp_status":
          setMcpServers(msg.servers);
          setMcpLoaded(true);
          break;
        case "model_unavailable":
          setModelUnavailable({ model: msg.model, family: msg.family, message: msg.message });
          break;
        case "history": {
          const items: TimelineItem[] = (msg.messages as { role: "user" | "assistant"; content: string }[]).map((m) => ({
            kind: m.role,
            id: uid(),
            text: m.content,
            ...(m.role === "assistant" ? { streaming: false } : {}),
          })) as TimelineItem[];
          setTimeline((t) => [...items, ...t]);
          break;
        }
        default:
          break;
      }
    };

    return () => ws.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, sessionId, projectId, resumeToken]);

  const sendMessage = useCallback((text: string, images?: Attachment[]) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    setTimeline((t) => [...t, { kind: "user", id: uid(), text, images }]);
    ws.send(JSON.stringify({ type: "user_message", text, images }));
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

  const switchModel = useCallback((newModel: string, family: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "set_model", model: newModel, family }));
  }, []);

  const dismissModelUnavailable = useCallback(() => setModelUnavailable(null), []);

  const send = useCallback((payload: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(payload));
  }, []);
  const mcpConnect = useCallback((name: string) => send({ type: "mcp_connect", name }), [send]);
  const mcpToggle = useCallback((name: string, enabled: boolean) => send({ type: enabled ? "mcp_enable" : "mcp_disable", name }), [send]);
  const mcpReload = useCallback(() => send({ type: "mcp_reload" }), [send]);

  return {
    connected,
    timeline,
    busy,
    permissionRequest,
    status,
    sessionInfo,
    mcpServers,
    mcpLoaded,
    modelUnavailable,
    sendMessage,
    answerPermission,
    interrupt,
    reconnect,
    switchModel,
    dismissModelUnavailable,
    mcpConnect,
    mcpToggle,
    mcpReload,
  };
}
