import { describe, expect, it } from "vitest";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { verifyDiscordSignature } from "../../src/channels/discord-signature.js";

// Real Ed25519 keypair, generated fresh per test file run — exercises the
// actual DER-wrapping/verification path, not a mocked crypto call.
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const publicKeyHex = (publicKey.export({ type: "spki", format: "der" }) as Buffer).subarray(12).toString("hex");

function sign(timestamp: string, rawBody: string): string {
  return cryptoSign(null, Buffer.from(timestamp + rawBody, "utf-8"), privateKey).toString("hex");
}

describe("verifyDiscordSignature (real Ed25519 keypair, real node:crypto sign/verify)", () => {
  it("accepts a genuinely valid signature", () => {
    const timestamp = "1700000000";
    const rawBody = JSON.stringify({ type: 1 });
    const signature = sign(timestamp, rawBody);

    expect(verifyDiscordSignature({ publicKeyHex, timestamp, signature, rawBody })).toBe(true);
  });

  it("rejects a signature from a different keypair", () => {
    const other = generateKeyPairSync("ed25519");
    const timestamp = "1700000000";
    const rawBody = "some body";
    const signature = cryptoSign(null, Buffer.from(timestamp + rawBody, "utf-8"), other.privateKey).toString("hex");

    expect(verifyDiscordSignature({ publicKeyHex, timestamp, signature, rawBody })).toBe(false);
  });

  it("rejects a signature over a different body than what's presented (tamper detection)", () => {
    const timestamp = "1700000000";
    const signature = sign(timestamp, "original body");

    expect(verifyDiscordSignature({ publicKeyHex, timestamp, signature, rawBody: "tampered body" })).toBe(false);
  });

  it("rejects a signature computed over a different timestamp", () => {
    const signature = sign("1700000000", "some body");
    expect(verifyDiscordSignature({ publicKeyHex, timestamp: "1700000099", signature, rawBody: "some body" })).toBe(false);
  });

  it("rejects a missing signature or timestamp outright", () => {
    expect(verifyDiscordSignature({ publicKeyHex, timestamp: undefined, signature: "a".repeat(128), rawBody: "x" })).toBe(false);
    expect(verifyDiscordSignature({ publicKeyHex, timestamp: "1700000000", signature: undefined, rawBody: "x" })).toBe(false);
  });

  it("rejects a malformed (wrong-length) signature instead of throwing", () => {
    expect(verifyDiscordSignature({ publicKeyHex, timestamp: "1700000000", signature: "not-hex-and-too-short", rawBody: "x" })).toBe(false);
  });

  it("rejects a malformed (wrong-length) public key instead of throwing", () => {
    const timestamp = "1700000000";
    const signature = sign(timestamp, "x");
    expect(verifyDiscordSignature({ publicKeyHex: "deadbeef", timestamp, signature, rawBody: "x" })).toBe(false);
  });
});
