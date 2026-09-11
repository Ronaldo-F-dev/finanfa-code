import { useCallback, useEffect, useRef, useState } from "react";

export type ToolRiskLevel = "safe" | "ask" | "dangerous";

export type TimelineItem =
  | { kind: "user"; id: string; text: string; images?: Attachment[] }
  | { kind: "assistant"; id: string; text: string; streaming: boolean }
  | { kind: "log"; id: string; variant: "system" | "error"; text: string }
  | { kind: "tool_call"; id: string; toolName: string; description: string; riskLevel: ToolRiskLevel }
  | { kind: "media"; id: string; mediaKind: "audio" | "image"; path: string; mimeType: string; webviewUri?: string };

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

export interface ModelUnavailable {
  model: string;
  family: string;
  message: string;
}

export interface Attachment {
  mimeType: string;
  base64: string;
}

export interface ModelOption {
  id: string;
  family: string;
  configured: boolean;
  baseUrl?: string;
  localModelId?: string;
}

export interface EffortTierInfo {
  id: string;
  label: string;
  description: string;
  model: string;
  ollamaModel?: string;
  installed: boolean;
}

export interface OllamaPullState {
  name: string;
  percent: number | null;
  error: string | null;
}

export interface SessionSummary {
  id: string;
  mtime: string;
  title?: string;
}

let nextId = 1;
const uid = () => String(nextId++);

// Real, restricted browser context inside a VS Code webview — no fetch to
// same-origin API routes, no WebSocket, just this one channel.
// `acquireVsCodeApi` itself is declared globally by @types/vscode-webview
// (a real npm devDependency, see package.json) rather than hand-rolled.
const vscode = acquireVsCodeApi();

/**
 * Port of packages/web-client/src/hooks/useAgentSocket.ts — same message
 * vocabulary and the same big `switch(msg.type)`, only the transport
 * differs: postMessage/window "message" events instead of a WebSocket. See
 * the plan's §1 for the full protocol and why this is deliberately kept as
 * close to a line-for-line port as possible (review-friendly diff, keeps
 * the door open to a real shared package later).
 *
 * Dropped vs. the web version (see plan's "what to drop" list): MCP/Tools
 * panel plumbing (mcpConnect/mcpToggle/mcpReload/setToolEnabled/
 * requestToolsStatus), plan mode, and the sessionId/projectId/reconnect
 * concerns — exactly one persistent connection per webview panel here,
 * no "switch to a different session" (that's the out-of-scope sidebar).
 */
export function useAgentBridge() {
  const [connected] = useState(true); // The extension host is always "there" once the webview exists — no connect/disconnect lifecycle to track.
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [busy, setBusy] = useState<{ active: boolean; label?: string }>({ active: false });
  const [permissionRequest, setPermissionRequest] = useState<PermissionRequest | null>(null);
  const [status, setStatus] = useState<StatusInfo | null>(null);
  const [sessionInfo, setSessionInfo] = useState<SessionInfo | null>(null);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [effortTiers, setEffortTiers] = useState<EffortTierInfo[]>([]);
  const [modelUnavailable, setModelUnavailable] = useState<ModelUnavailable | null>(null);
  const [effortNeedsDownload, setEffortNeedsDownload] = useState<EffortNeedsDownload | null>(null);
  const [ollamaPull, setOllamaPull] = useState<OllamaPullState | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const streamingIdRef = useRef<string | null>(null);

  useEffect(() => {
    // No origin check: inside a VS Code webview this channel only ever
    // carries messages from the owning extension host (postMessage), not
    // arbitrary web content — there is no other origin able to reach it.
    function onMessage(event: MessageEvent): void {
      const msg = event.data;
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
          setTimeline((t) => [...t, { kind: "media", id: uid(), mediaKind: msg.kind, path: msg.path, mimeType: msg.mimeType, webviewUri: msg.webviewUri }]);
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
          setSessionInfo({ id: msg.id, title: msg.title, model: msg.model, providerKind: msg.providerKind, toolCount: msg.toolCount, effort: msg.effort });
          break;
        }
        case "model_list":
          setModels(msg.models);
          break;
        case "effort_tiers":
          setEffortTiers(msg.tiers);
          break;
        case "sessions":
          setSessions(msg.sessions);
          break;
        case "model_unavailable":
          setModelUnavailable({ model: msg.model, family: msg.family, message: msg.message });
          break;
        case "effort_needs_download":
          setEffortNeedsDownload({ level: msg.level, ollamaModel: msg.ollamaModel });
          break;
        case "ollama_pull_progress":
          setOllamaPull((prev) => ({
            name: msg.name ?? prev?.name ?? "",
            percent: typeof msg.total === "number" && msg.total > 0 ? Math.round(((msg.completed ?? 0) / msg.total) * 100) : (prev?.percent ?? null),
            error: null,
          }));
          break;
        case "ollama_pull_done":
          setOllamaPull(null);
          break;
        case "ollama_pull_error":
          setOllamaPull((prev) => (prev ? { ...prev, error: msg.message } : { name: "", percent: null, error: msg.message }));
          break;
        case "history": {
          const items: TimelineItem[] = (msg.messages as { role: "user" | "assistant" | "error"; content: string }[]).map((m) =>
            m.role === "error"
              ? { kind: "log", id: uid(), variant: "error", text: m.content }
              : ({ kind: m.role, id: uid(), text: m.content, ...(m.role === "assistant" ? { streaming: false } : {}) } as TimelineItem),
          );
          setTimeline((t) => (msg.replace ? items : [...items, ...t]));
          break;
        }
        default:
          break;
      }
    }

    window.addEventListener("message", onMessage);
    vscode.postMessage({ type: "webview_ready" });
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const sendMessage = useCallback((text: string, images?: Attachment[]) => {
    setTimeline((t) => [...t, { kind: "user", id: uid(), text, images }]);
    vscode.postMessage({ type: "user_message", text, images });
  }, []);

  const answerPermission = useCallback((requestId: number, answer: string) => {
    vscode.postMessage({ type: "permission_response", requestId, answer });
    setPermissionRequest((current) => (current?.requestId === requestId ? null : current));
  }, []);

  const interrupt = useCallback(() => vscode.postMessage({ type: "interrupt" }), []);
  const newChat = useCallback(() => vscode.postMessage({ type: "new_chat" }), []);
  const compact = useCallback(() => vscode.postMessage({ type: "compact" }), []);
  const switchModel = useCallback(
    (newModel: string, family: string, baseUrl?: string) => vscode.postMessage({ type: "set_model", model: newModel, family, baseUrl }),
    [],
  );
  const setEffort = useCallback((level: string) => vscode.postMessage({ type: "set_effort", level }), []);
  const pullOllamaModel = useCallback((name: string) => {
    setOllamaPull({ name, percent: 0, error: null });
    vscode.postMessage({ type: "pull_ollama_model", name });
  }, []);
  const dismissModelUnavailable = useCallback(() => setModelUnavailable(null), []);
  const dismissEffortNeedsDownload = useCallback(() => setEffortNeedsDownload(null), []);
  // Intercepted by chat-view-provider.ts directly (a native VS Code
  // notification, not engine wiring) — see its onDidReceiveMessage.
  const requestApiKeyHelp = useCallback((model: string) => vscode.postMessage({ type: "needs_api_key", model }), []);
  const listSessions = useCallback(() => vscode.postMessage({ type: "list_sessions" }), []);
  const switchSession = useCallback((id: string) => vscode.postMessage({ type: "switch_session", id }), []);
  const deleteSession = useCallback((id: string) => vscode.postMessage({ type: "delete_session", id }), []);

  return {
    connected,
    timeline,
    busy,
    permissionRequest,
    status,
    sessionInfo,
    models,
    effortTiers,
    modelUnavailable,
    effortNeedsDownload,
    ollamaPull,
    sendMessage,
    answerPermission,
    interrupt,
    newChat,
    compact,
    switchModel,
    setEffort,
    pullOllamaModel,
    dismissModelUnavailable,
    dismissEffortNeedsDownload,
    requestApiKeyHelp,
    sessions,
    listSessions,
    switchSession,
    deleteSession,
  };
}
