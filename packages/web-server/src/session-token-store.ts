import { randomBytes } from "node:crypto";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// A logged-in user's session token — real, opaque, server-generated
// (never derived from the password), the counterpart to a static
// FINANFA_WEB_USERS token but issued per real login rather than shared
// out of band.
//
// Persisted to disk (~/.finanfa-code/web-sessions.json, same tmp+rename
// convention as user-store.ts's account file) — a real gap this used to
// leave open: every logged-in user previously had to log in again after
// any server restart (redeploy, crash), since a session lived only in
// this process's memory. `restore()` reloads whatever wasn't expired yet
// from a previous process; `validate` itself stays synchronous and
// memory-only (no disk I/O on the hot per-request path) — persistence
// only happens on the much rarer issue/revoke.
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

interface SessionEntry {
  user: string;
  expiresAt: number;
}

export function defaultSessionStorePath(): string {
  return path.join(os.homedir(), ".finanfa-code", "web-sessions.json");
}

type PersistedSessions = Record<string, SessionEntry>;

async function loadPersistedSessions(filePath: string): Promise<PersistedSessions> {
  try {
    return JSON.parse(await readFile(filePath, "utf-8")) as PersistedSessions;
  } catch {
    return {};
  }
}

async function savePersistedSessions(filePath: string, sessions: PersistedSessions): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  await writeFile(tmp, JSON.stringify(sessions), "utf-8");
  await rename(tmp, filePath);
}

export class SessionTokenStore {
  private readonly sessions = new Map<string, SessionEntry>();

  /** Pass no path (or undefined) for a purely in-memory store that never touches disk — what every existing test uses, and what a caller that doesn't want persistence can still get. */
  constructor(private readonly filePath?: string) {}

  /** Restores whatever sessions this store's filePath has persisted from a previous process, skipping any that already expired in the meantime. A no-op for a purely in-memory store (no filePath). Call once, right after construction, before serving any request. */
  async restore(): Promise<void> {
    if (!this.filePath) return;
    const persisted = await loadPersistedSessions(this.filePath);
    const now = Date.now();
    for (const [token, entry] of Object.entries(persisted)) {
      if (entry.expiresAt > now) this.sessions.set(token, entry);
    }
  }

  private async persist(): Promise<void> {
    if (!this.filePath) return;
    await savePersistedSessions(this.filePath, Object.fromEntries(this.sessions));
  }

  async issue(user: string): Promise<string> {
    const token = randomBytes(32).toString("hex");
    this.sessions.set(token, { user, expiresAt: Date.now() + SESSION_TTL_MS });
    await this.persist();
    return token;
  }

  /** Undefined for a token that was never issued, or that expired — either way, "not currently authenticated," not distinguished further to the caller. Stays synchronous (no disk I/O) since this runs on every authenticated request. */
  validate(token: string): string | undefined {
    const entry = this.sessions.get(token);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.sessions.delete(token);
      return undefined;
    }
    return entry.user;
  }

  async revoke(token: string): Promise<void> {
    this.sessions.delete(token);
    await this.persist();
  }
}
