import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getOrCreateSigningIdentity, fingerprintPublicKey, signPayload, verifyPayload, canonicalJson } from "../../src/core/claws-signing.js";

describe("getOrCreateSigningIdentity (real Ed25519 keypair, real file on disk)", () => {
  let dir: string;
  let identityPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "finanfa-claws-signing-"));
    identityPath = path.join(dir, "claws-identity.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("generates a real keypair the first time, and persists it", async () => {
    const identity = await getOrCreateSigningIdentity(identityPath);
    expect(identity.privateKeyPem).toContain("BEGIN PRIVATE KEY");
    expect(identity.publicKeyPem).toContain("BEGIN PUBLIC KEY");
    const onDisk = JSON.parse(await readFile(identityPath, "utf-8"));
    expect(onDisk).toEqual(identity);
  });

  it("returns the SAME identity on a second call — a stable identity, not regenerated every time", async () => {
    const first = await getOrCreateSigningIdentity(identityPath);
    const second = await getOrCreateSigningIdentity(identityPath);
    expect(second).toEqual(first);
  });
});

describe("signPayload / verifyPayload (real Ed25519 signing)", () => {
  it("verifies a real signature against the matching public key", async () => {
    const identity = await getOrCreateSigningIdentity(path.join(await mkdtemp(path.join(tmpdir(), "finanfa-claws-signing-")), "identity.json"));
    const signature = signPayload("hello world", identity.privateKeyPem);
    expect(verifyPayload("hello world", signature, identity.publicKeyPem)).toBe(true);
  });

  it("rejects a signature for different content (tamper detection)", async () => {
    const identity = await getOrCreateSigningIdentity(path.join(await mkdtemp(path.join(tmpdir(), "finanfa-claws-signing-")), "identity.json"));
    const signature = signPayload("hello world", identity.privateKeyPem);
    expect(verifyPayload("hello world!", signature, identity.publicKeyPem)).toBe(false);
  });

  it("rejects a signature verified against a DIFFERENT identity's public key", async () => {
    const identityA = await getOrCreateSigningIdentity(path.join(await mkdtemp(path.join(tmpdir(), "finanfa-claws-signing-")), "identity.json"));
    const identityB = await getOrCreateSigningIdentity(path.join(await mkdtemp(path.join(tmpdir(), "finanfa-claws-signing-")), "identity.json"));
    const signature = signPayload("hello world", identityA.privateKeyPem);
    expect(verifyPayload("hello world", signature, identityB.publicKeyPem)).toBe(false);
  });

  it("returns false (not a throw) for a malformed signature or key", () => {
    expect(verifyPayload("hello", "not-real-base64!!!", "not a real pem")).toBe(false);
  });
});

describe("fingerprintPublicKey", () => {
  it("gives the same fingerprint for the same key, a different one for a different key", async () => {
    const identityA = await getOrCreateSigningIdentity(path.join(await mkdtemp(path.join(tmpdir(), "finanfa-claws-signing-")), "identity.json"));
    const identityB = await getOrCreateSigningIdentity(path.join(await mkdtemp(path.join(tmpdir(), "finanfa-claws-signing-")), "identity.json"));
    expect(fingerprintPublicKey(identityA.publicKeyPem)).toBe(fingerprintPublicKey(identityA.publicKeyPem));
    expect(fingerprintPublicKey(identityA.publicKeyPem)).not.toBe(fingerprintPublicKey(identityB.publicKeyPem));
  });
});

describe("canonicalJson", () => {
  it("produces the same output regardless of key insertion order", () => {
    const a = canonicalJson({ b: 1, a: 2, nested: { z: 1, y: 2 } });
    const b = canonicalJson({ a: 2, b: 1, nested: { y: 2, z: 1 } });
    expect(a).toBe(b);
  });

  it("produces different output for genuinely different content", () => {
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: 2 }));
  });
});
