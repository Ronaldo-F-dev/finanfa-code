import type { TimelineItem } from "./hooks/useAgentSocket";

export interface RestorePoint {
  number: number;
  preview: string;
  clientId?: string;
}

/** Maps each user message the browser showed (by the id it sent with it) to the server's restore point for it. */
export function restorePointsByClientId(points: RestorePoint[]): Map<string, number> {
  const byId = new Map<string, number>();
  for (const p of points) if (p.clientId) byId.set(p.clientId, p.number);
  return byId;
}

export interface TruncateResult {
  timeline: TimelineItem[];
  /** The text of the message restored to before, so the composer can offer it again for editing. Undefined when no such message was found. */
  text?: string;
}

/**
 * The timeline as it was just before the user message with `clientId`: that message and everything after it
 * (answers, tool calls, notes) are gone. A clientId that isn't in the timeline leaves it untouched.
 */
export function truncateBeforeUserMessage(timeline: TimelineItem[], clientId: string): TruncateResult {
  const index = timeline.findIndex((item) => item.kind === "user" && item.clientId === clientId);
  if (index === -1) return { timeline };
  const target = timeline[index] as Extract<TimelineItem, { kind: "user" }>;
  return { timeline: timeline.slice(0, index), text: target.text };
}
