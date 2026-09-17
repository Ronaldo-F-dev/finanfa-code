/**
 * Tracks recently-seen update ids for an inbound channel webhook, so a
 * redelivered update (Telegram retries a webhook call it never got a fast
 * 200 for; WhatsApp/a restart replays queued updates) doesn't run a
 * second full agent turn and post a duplicate reply. Bounded in-memory
 * (no persistence needed — redelivery happens within the platform's own
 * short retry window, never across a process restart's own lifetime),
 * one instance per channel/purpose so unrelated channels can't collide.
 * Generic over the id type — Telegram's `update_id` is a number,
 * WhatsApp's message id is a string; both are just "the platform's own
 * unique id for this one delivery attempt" either way.
 */
export class UpdateDedupTracker<TId = number> {
  private readonly seen = new Set<TId>();
  private readonly order: TId[] = [];

  constructor(private readonly maxTracked = 1000) {}

  /** Returns true (and remembers it) the first time this id is seen; false on every later call for the same id. */
  markSeen(updateId: TId): boolean {
    if (this.seen.has(updateId)) return false;
    this.seen.add(updateId);
    this.order.push(updateId);
    if (this.order.length > this.maxTracked) {
      const oldest = this.order.shift();
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    return true;
  }
}
