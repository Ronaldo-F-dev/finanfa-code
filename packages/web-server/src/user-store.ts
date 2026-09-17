import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// Real, persisted user accounts with hashed passwords — the actual
// "multi-user" half of Gateway that a static FINANFA_WEB_USERS token
// map (see auth.ts) doesn't give you: a real account an operator can
// create for someone else without sharing a long-lived secret out of
// band, that person then logs in with their own password (see
// session-store.ts for the session token that login issues).
//
// scrypt (Node's own built-in, no external bcrypt dependency) with a
// random salt per password — not a fixed/shared salt, and never the
// plain password itself, persisted to disk.
const SCRYPT_KEY_LENGTH = 64;

export function defaultUserStorePath(): string {
  return path.join(os.homedir(), ".finanfa-code", "web-users.json");
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT_KEY_LENGTH);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(password, salt, expected.length);
  // timingSafeEqual throws on a length mismatch rather than returning
  // false — a corrupt/truncated stored hash must not crash the login
  // request, so length is checked first.
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export type UserStore = Record<string, string>; // username -> hashPassword() output

export async function loadUserStore(filePath: string = defaultUserStorePath()): Promise<UserStore> {
  try {
    const raw = await readFile(filePath, "utf-8");
    return JSON.parse(raw) as UserStore;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      console.error(`Warning: failed to read ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return {};
  }
}

async function saveUserStore(filePath: string, store: UserStore): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  await writeFile(tmp, JSON.stringify(store, null, 2), "utf-8");
  await rename(tmp, filePath);
}

export type CreateUserResult = { ok: true } | { ok: false; error: string };

/** Creates a NEW account (fails if the username already exists — use a separate flow to change a password, not this) or updates one that already exists, per `overwrite`. */
export async function createUser(username: string, password: string, filePath: string = defaultUserStorePath(), overwrite = false): Promise<CreateUserResult> {
  if (!username.trim()) return { ok: false, error: "Username can't be empty." };
  if (password.length < 8) return { ok: false, error: "Password must be at least 8 characters." };
  const store = await loadUserStore(filePath);
  if (store[username] && !overwrite) return { ok: false, error: `User "${username}" already exists.` };
  store[username] = hashPassword(password);
  await saveUserStore(filePath, store);
  return { ok: true };
}

export async function verifyUserPassword(username: string, password: string, filePath: string = defaultUserStorePath()): Promise<boolean> {
  const store = await loadUserStore(filePath);
  const stored = store[username];
  if (!stored) return false;
  return verifyPassword(password, stored);
}
