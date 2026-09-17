import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isKnownPublisher, recordPublisherSeen, loadTrustStore } from "../../src/core/claws-trust-store.js";

describe("claws trust store (real file on disk)", () => {
  let dir: string;
  let storePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "finanfa-claws-trust-"));
    storePath = path.join(dir, "trusted-publishers.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("a fingerprint never seen before is not a known publisher", async () => {
    expect(await isKnownPublisher("abc123", storePath)).toBe(false);
  });

  it("recordPublisherSeen makes a fingerprint a known publisher from then on", async () => {
    await recordPublisherSeen("abc123", undefined, storePath);
    expect(await isKnownPublisher("abc123", storePath)).toBe(true);
  });

  it("records firstSeenAt once, keeping it stable across repeated recordPublisherSeen calls", async () => {
    await recordPublisherSeen("abc123", undefined, storePath);
    const store = await loadTrustStore(storePath);
    const firstSeenAt = store.abc123!.firstSeenAt;

    await new Promise((r) => setTimeout(r, 5));
    await recordPublisherSeen("abc123", undefined, storePath);
    const storeAgain = await loadTrustStore(storePath);
    expect(storeAgain.abc123!.firstSeenAt).toBe(firstSeenAt);
  });

  it("tracks multiple publishers independently", async () => {
    await recordPublisherSeen("fingerprint-a", "Alice's machine", storePath);
    await recordPublisherSeen("fingerprint-b", "Bob's machine", storePath);
    const store = await loadTrustStore(storePath);
    expect(Object.keys(store).sort()).toEqual(["fingerprint-a", "fingerprint-b"]);
    expect(store["fingerprint-a"]?.label).toBe("Alice's machine");
  });

  it("loadTrustStore returns an empty store when the file doesn't exist yet", async () => {
    expect(await loadTrustStore(storePath)).toEqual({});
  });
});
