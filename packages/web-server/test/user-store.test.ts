import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { hashPassword, verifyPassword, loadUserStore, createUser, verifyUserPassword } from "../src/user-store.js";

describe("hashPassword/verifyPassword", () => {
  it("verifies the correct password against its own hash", () => {
    const stored = hashPassword("correct horse battery staple");
    expect(verifyPassword("correct horse battery staple", stored)).toBe(true);
  });

  it("rejects the wrong password", () => {
    const stored = hashPassword("correct horse battery staple");
    expect(verifyPassword("wrong password", stored)).toBe(false);
  });

  it("never stores the plain password in the hash output", () => {
    const stored = hashPassword("my-real-password");
    expect(stored).not.toContain("my-real-password");
  });

  it("uses a random salt — hashing the same password twice gives different output", () => {
    const a = hashPassword("same password");
    const b = hashPassword("same password");
    expect(a).not.toBe(b);
    expect(verifyPassword("same password", a)).toBe(true);
    expect(verifyPassword("same password", b)).toBe(true);
  });

  it("rejects a corrupted/malformed stored hash instead of throwing", () => {
    expect(verifyPassword("anything", "not-a-real-hash")).toBe(false);
    expect(verifyPassword("anything", "")).toBe(false);
  });
});

describe("createUser / verifyUserPassword / loadUserStore (real file on disk)", () => {
  let dir: string;
  let storePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "finanfa-user-store-"));
    storePath = path.join(dir, "web-users.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("loadUserStore returns an empty store when the file doesn't exist yet", async () => {
    expect(await loadUserStore(storePath)).toEqual({});
  });

  it("createUser persists a real account, verifyUserPassword checks it correctly", async () => {
    const result = await createUser("alice", "correct-password-123", storePath);
    expect(result).toEqual({ ok: true });

    expect(await verifyUserPassword("alice", "correct-password-123", storePath)).toBe(true);
    expect(await verifyUserPassword("alice", "wrong-password", storePath)).toBe(false);
    expect(await verifyUserPassword("nonexistent-user", "anything", storePath)).toBe(false);
  });

  it("createUser rejects a duplicate username unless overwrite is passed", async () => {
    await createUser("alice", "first-password-123", storePath);
    const duplicate = await createUser("alice", "second-password-123", storePath);
    expect(duplicate.ok).toBe(false);

    const overwritten = await createUser("alice", "second-password-123", storePath, true);
    expect(overwritten).toEqual({ ok: true });
    expect(await verifyUserPassword("alice", "second-password-123", storePath)).toBe(true);
  });

  it("createUser rejects an empty username or a too-short password", async () => {
    expect((await createUser("", "a-fine-password", storePath)).ok).toBe(false);
    expect((await createUser("bob", "short", storePath)).ok).toBe(false);
  });

  it("loadUserStore reflects multiple accounts created over time", async () => {
    await createUser("alice", "alice-password-123", storePath);
    await createUser("bob", "bob-password-123", storePath);
    const store = await loadUserStore(storePath);
    expect(Object.keys(store).sort()).toEqual(["alice", "bob"]);
  });
});
