import { createPublicKey, verify as cryptoVerify, type KeyObject } from "node:crypto";

// Discord's Ed25519-signed interactions:
// https://discord.com/developers/docs/interactions/receiving-and-responding#security-and-authorization
// Every interaction POST carries X-Signature-Ed25519 and
// X-Signature-Timestamp headers; the signed message is
// `${timestamp}${rawBody}`. Discord's dashboard gives you the app's raw
// 32-byte Ed25519 public key as hex — not a PEM/SPKI key — so it's
// wrapped in Ed25519's fixed SPKI DER prefix here rather than pulling in
// a whole library just for this, same "raw node:crypto, no SDK" approach
// as slack-signature.ts's HMAC and telegram-secret.ts's compare.
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function toEd25519PublicKey(publicKeyHex: string): KeyObject | undefined {
  if (!/^[0-9a-fA-F]{64}$/.test(publicKeyHex)) return undefined; // must be exactly 32 raw bytes
  try {
    return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKeyHex, "hex")]), format: "der", type: "spki" });
  } catch {
    return undefined;
  }
}

export interface VerifyDiscordSignatureInput {
  publicKeyHex: string;
  timestamp: string | undefined;
  signature: string | undefined;
  rawBody: string;
}

export function verifyDiscordSignature(input: VerifyDiscordSignatureInput): boolean {
  const { publicKeyHex, timestamp, signature, rawBody } = input;
  if (!timestamp || !signature) return false;
  if (!/^[0-9a-fA-F]{128}$/.test(signature)) return false; // must be exactly 64 raw bytes

  const publicKey = toEd25519PublicKey(publicKeyHex);
  if (!publicKey) return false;

  try {
    // Ed25519 uses a null digest algorithm — the signing/verification is
    // over the raw message, not a pre-hashed digest the way ECDSA/RSA
    // signatures usually are.
    return cryptoVerify(null, Buffer.from(timestamp + rawBody, "utf-8"), publicKey, Buffer.from(signature, "hex"));
  } catch {
    return false;
  }
}
