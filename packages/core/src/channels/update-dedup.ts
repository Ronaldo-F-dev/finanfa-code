/**
 * Tracks recently-seen update ids for an inbound channel webhook, so a
 * redelivered update (Telegram retries a webhook call it never got a fast
 * 200 for; a restart replays queued updates) doesn't run a second full
 * agent turn and post a duplicate reply. Bounded in-memory (no persistence
 * needed — redelivery happens within Telegram's own short retry window,
 * never across a process restart's own lifetime), one instance per
 * channel/purpose so unrelated channels can't collide.
 */
export class UpdateDedupTracker {
  private readonly seen = new Set<number>();
  private readonly order: number[] = [];

  constructor(private readonly maxTracked = 1000) {}

  /** Returns true (and remembers it) the first time this id is seen; false on every later call for the same id. */
  markSeen(updateId: number): boolean {
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
