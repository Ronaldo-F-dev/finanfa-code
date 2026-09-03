import { useCallback, useEffect, useRef, useState } from "react";

export type TimelineItem =
  | { kind: "user"; id: string; text: string }
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

let nextId = 1;
const uid = () => String(nextId++);

export function useAgentSocket(model: string | undefined) {
  const [connected, setConnected] = useState(false);
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [busy, setBusy] = useState<{ active: boolean; label?: string }>({ active: false });
  const [permissionRequest, setPermissionRequest] = useState<PermissionRequest | null>(null);
  const [status, setStatus] = useState<StatusInfo | null>(null);
  const [sessionKey, setSessionKey] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);
  const streamingIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!model) return;
    setTimeline([]);
    setStatus(null);
    setBusy({ active: false });
    setPermissionRequest(null);
    streamingIdRef.current = null;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/ws?model=${encodeURIComponent(model)}`);
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
        default:
          break;
      }
    };

    return () => ws.close();
  }, [model, sessionKey]);

  const sendMessage = useCallback((text: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    setTimeline((t) => [...t, { kind: "user", id: uid(), text }]);
    ws.send(JSON.stringify({ type: "user_message", text }));
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

  const startNewChat = useCallback(() => setSessionKey((k) => k + 1), []);

  return { connected, timeline, busy, permissionRequest, status, sendMessage, answerPermission, interrupt, startNewChat };
}
