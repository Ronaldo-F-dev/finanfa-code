import WebSocket from "ws";

/** One raw WS message from the server, JSON-parsed. Loosely typed on purpose — each test only ever asserts on a few fields. */
export interface WsEvent {
  type: string;
  text?: string;
  [key: string]: unknown;
}

/**
 * Opens a real WebSocket and starts collecting every message it receives.
 * The listener is attached BEFORE awaiting "open": the server can send
 * session_info as soon as its connection handler is ready, and a listener
 * attached only once the client observes "open" can miss it entirely (no
 * replay on a plain ws client) — a latent race in every earlier e2e file
 * that started biting for real once the server's startup got faster
 * (parallel startup loaders). Extracted after the same connect+collect
 * block (and its own copy of the WsEvent interface) was copied into each
 * new e2e file; callers wait for whatever event they need next
 * (session_info included) with their own waitFor/vi.waitFor.
 */
export async function connectWebSocket(port: number, query = ""): Promise<{ ws: WebSocket; events: WsEvent[] }> {
  const events: WsEvent[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws${query}`);
  ws.on("message", (raw: Buffer) => events.push(JSON.parse(raw.toString()) as WsEvent));
  await new Promise<void>((resolve, reject) => {
    ws.on("open", () => resolve());
    ws.on("error", reject);
  });
  return { ws, events };
}
