import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionTokenStore } from "../src/session-token-store.js";

describe("SessionTokenStore (in-memory, no filePath)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("issues a real, unique token per call and validates it back to the right user", async () => {
    const store = new SessionTokenStore();
    const aliceToken = await store.issue("alice");
    const bobToken = await store.issue("bob");
    expect(aliceToken).not.toBe(bobToken);
    expect(store.validate(aliceToken)).toBe("alice");
    expect(store.validate(bobToken)).toBe("bob");
  });

  it("returns undefined for a token that was never issued", () => {
    const store = new SessionTokenStore();
    expect(store.validate("not-a-real-token")).toBeUndefined();
  });

  it("revoke makes a previously-valid token invalid", async () => {
    const store = new SessionTokenStore();
    const token = await store.issue("alice");
    expect(store.validate(token)).toBe("alice");
    await store.revoke(token);
    expect(store.validate(token)).toBeUndefined();
  });

  it("a token expires after its real TTL", async () => {
    vi.useFakeTimers();
    const store = new SessionTokenStore();
    const token = await store.issue("alice");
    expect(store.validate(token)).toBe("alice");

    vi.advanceTimersByTime(31 * 24 * 60 * 60 * 1000); // 31 days — past the real 30-day TTL
    expect(store.validate(token)).toBeUndefined();
  });

  it("restore() is a harmless no-op when there's no filePath at all", async () => {
    const store = new SessionTokenStore();
    await expect(store.restore()).resolves.toBeUndefined();
  });
});

describe("SessionTokenStore (persisted to a real file on disk)", () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "finanfa-session-store-"));
    filePath = path.join(dir, "web-sessions.json");
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(dir, { recursive: true, force: true });
  });

  it("a session issued by one store instance survives a restart (a fresh instance restoring from the same file)", async () => {
    const before = new SessionTokenStore(filePath);
    const token = await before.issue("alice");

    const after = new SessionTokenStore(filePath);
    expect(after.validate(token)).toBeUndefined(); // not restored yet
    await after.restore();
    expect(after.validate(token)).toBe("alice");
  });

  it("revoke persists too — a restarted store doesn't resurrect a revoked token", async () => {
    const before = new SessionTokenStore(filePath);
    const token = await before.issue("alice");
    await before.revoke(token);

    const after = new SessionTokenStore(filePath);
    await after.restore();
    expect(after.validate(token)).toBeUndefined();
  });

  it("restore() skips a session that already expired while the process was down", async () => {
    vi.useFakeTimers();
    const before = new SessionTokenStore(filePath);
    const token = await before.issue("alice");
    vi.advanceTimersByTime(31 * 24 * 60 * 60 * 1000); // 31 days — past the real 30-day TTL

    const after = new SessionTokenStore(filePath);
    await after.restore();
    expect(after.validate(token)).toBeUndefined();
  });

  it("restore() from a file that doesn't exist yet is a harmless no-op", async () => {
    const store = new SessionTokenStore(path.join(dir, "never-written.json"));
    await expect(store.restore()).resolves.toBeUndefined();
  });
});
