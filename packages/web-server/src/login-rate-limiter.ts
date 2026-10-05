// Brute-force protection for POST /api/auth/login — nothing in
// user-store.ts (scrypt hashing) or session-token-store.ts throttles
// *attempts*, only slows a single guess. Without this, an attacker who
// finds a deployed instance's URL can fire login POSTs as fast as the
// network and Node's event loop allow, bound only by scrypt's cost
// (likely tens-to-hundreds/sec), enough to brute-force a weak password
// in minutes to hours.
//
// Keyed by `${ip}:${username}` rather than IP alone or username alone:
// IP alone would let one attacker behind a shared IP (office NAT,
// campus network) lock out everyone else trying to log into their own
// account from that IP; username alone would let a distributed attacker
// (many IPs) bypass the limit entirely for a single targeted account.
// In-memory only (not persisted) — a restart clearing counters is an
// acceptable tradeoff for a single-process deployment; this is a
// throttle against automation, not a durable audit log.

const WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60_000;

interface Entry {
  failures: number;
  windowStart: number;
  lockedUntil: number;
}

export class LoginRateLimiter {
  private readonly entries = new Map<string, Entry>();

  private key(ip: string, username: string): string {
    return `${ip}:${username}`;
  }

  /** Returns the number of ms the caller must wait before retrying, or 0 if the attempt is allowed right now. Does not itself record a failure — call recordFailure()/recordSuccess() after the real auth check. */
  retryAfterMs(ip: string, username: string, now = Date.now()): number {
    const entry = this.entries.get(this.key(ip, username));
    if (!entry) return 0;
    if (now < entry.lockedUntil) return entry.lockedUntil - now;
    return 0;
  }

  recordFailure(ip: string, username: string, now = Date.now()): void {
    const k = this.key(ip, username);
    const entry = this.entries.get(k);
    if (!entry || now - entry.windowStart > WINDOW_MS) {
      this.entries.set(k, { failures: 1, windowStart: now, lockedUntil: 0 });
      return;
    }
    entry.failures += 1;
    if (entry.failures >= MAX_ATTEMPTS) entry.lockedUntil = now + LOCKOUT_MS;
  }

  recordSuccess(ip: string, username: string): void {
    this.entries.delete(this.key(ip, username));
  }

  /** Bounds the Map's lifetime memory use — called opportunistically from the login handler rather than on a timer, so an idle server doesn't need a background interval just for this. */
  pruneExpired(now = Date.now()): void {
    for (const [k, entry] of this.entries) {
      if (now - entry.windowStart > WINDOW_MS && now >= entry.lockedUntil) this.entries.delete(k);
    }
  }
}
