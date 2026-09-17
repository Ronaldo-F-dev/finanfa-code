import { randomBytes } from "node:crypto";

// A logged-in user's session token — real, opaque, server-generated
// (never derived from the password), the counterpart to a static
// FINANFA_WEB_USERS token but issued per real login rather than shared
// out of band. In-memory only, deliberately: unlike an account itself
// (persisted — see user-store.ts), a session token is meant to expire
// and not needing to survive a server restart is a reasonable, honest
// simplification — a restart just requires logging in again, the same
// experience an expired token already gives.
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

interface SessionEntry {
  user: string;
  expiresAt: number;
}

export class SessionTokenStore {
  private readonly sessions = new Map<string, SessionEntry>();

  issue(user: string): string {
    const token = randomBytes(32).toString("hex");
    this.sessions.set(token, { user, expiresAt: Date.now() + SESSION_TTL_MS });
    return token;
  }

  /** Undefined for a token that was never issued, or that expired — either way, "not currently authenticated," not distinguished further to the caller. */
  validate(token: string): string | undefined {
    const entry = this.sessions.get(token);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.sessions.delete(token);
      return undefined;
    }
    return entry.user;
  }

  revoke(token: string): void {
    this.sessions.delete(token);
  }
}
