declare global {
  namespace Express {
    interface Request {
      /** The authenticated user for this request (see parseWebUsers/authenticateBearerToken) — undefined when FINANFA_WEB_USERS isn't configured at all, which is every existing single-user deployment. */
      user?: string;
    }
  }
}

// Opt-in multi-user authentication for the web server ("Gateway" — a
// real gap relative to a comparable project's own multi-user/multi-
// client control plane). Unset by default: every existing single-user
// local-dev deployment keeps working exactly as before, fully open, with
// zero required migration. Set FINANFA_WEB_USERS to require a token on
// every /api/* request and the WebSocket upgrade, and to isolate each
// user's own sessions from everyone else's (see index.ts).
//
// Deliberately scoped: this is authentication + per-user SESSION
// isolation within one existing web-server process, not a separate
// control-plane service coordinating multiple downstream agent
// instances (that would be a much larger, genuinely different
// architecture change) — and it gates /api/*+/ws only, not the static
// SPA shell itself (a browser can't easily attach an Authorization
// header to a plain page load; the SPA's own API calls are what actually
// need a token, typically entered once in Settings and kept in
// localStorage).
export function parseWebUsers(env: NodeJS.ProcessEnv = process.env): Map<string, string> | undefined {
  const raw = env.FINANFA_WEB_USERS;
  if (!raw) return undefined;
  const byToken = new Map<string, string>();
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const colonIndex = trimmed.indexOf(":");
    if (colonIndex === -1) continue; // malformed entry — skipped rather than crashing startup over a typo
    const user = trimmed.slice(0, colonIndex).trim();
    const token = trimmed.slice(colonIndex + 1).trim();
    if (user && token) byToken.set(token, user);
  }
  return byToken.size > 0 ? byToken : undefined;
}

import type { SessionTokenStore } from "./session-token-store.js";

/**
 * A presented token is checked against BOTH sources: the static
 * FINANFA_WEB_USERS map (a fixed, operator-configured shared secret —
 * simple, scriptable, no login flow) and real per-login session tokens
 * (see session-token-store.ts, issued by POST /api/auth/login against a
 * real hashed-password account — see user-store.ts). Either kind
 * authenticates identically from here on; nothing downstream needs to
 * know which one it was.
 */
export function authenticateToken(users: Map<string, string>, sessions: SessionTokenStore, token: string | undefined): string | undefined {
  if (!token) return undefined;
  return users.get(token) ?? sessions.validate(token);
}

export function authenticateBearerToken(users: Map<string, string>, sessions: SessionTokenStore, authorizationHeader: string | undefined): string | undefined {
  if (!authorizationHeader?.startsWith("Bearer ")) return undefined;
  return authenticateToken(users, sessions, authorizationHeader.slice("Bearer ".length));
}

export function authenticateQueryToken(users: Map<string, string>, sessions: SessionTokenStore, token: string | null): string | undefined {
  return authenticateToken(users, sessions, token ?? undefined);
}
