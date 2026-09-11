import type { AgentSession } from "@finanfa/core/src/core/session.js";

export interface HistoryReplayItem {
  role: "user" | "assistant" | "error";
  content: string;
}

/**
 * Builds the same "history" replay shape the web server sends a reconnecting
 * client (packages/web-server/src/index.ts, the requestedSessionId branch) —
 * interleaving past errorLog entries back into their original position
 * (afterMessageIndex) alongside the ordinary user/assistant text, so a
 * resumed webview sees a failure exactly where it happened, not all bunched
 * at the start or end.
 */
export function buildHistoryReplay(session: AgentSession): HistoryReplayItem[] {
  const replay: HistoryReplayItem[] = [];
  let errorIdx = 0;
  for (let i = 0; i <= session.messages.length; i++) {
    while (errorIdx < session.errorLog.length && session.errorLog[errorIdx]!.afterMessageIndex === i) {
      replay.push({ role: "error", content: session.errorLog[errorIdx]!.text });
      errorIdx++;
    }
    const m = session.messages[i];
    if (m && (m.role === "user" || m.role === "assistant")) replay.push({ role: m.role, content: m.content });
  }
  return replay;
}
