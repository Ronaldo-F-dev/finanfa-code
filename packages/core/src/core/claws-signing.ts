import { generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify, createPrivateKey, createPublicKey, createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// Real cryptographic provenance for Claws bundles (see claw-bundle.ts) —
// Ed25519 signing (Node's own built-in crypto, no external dependency),
// closing the "provenance is just an unverified sourceProjectPath
// string" gap this project's first Claws pass had. A bundle's `files`
// are signed by whoever exported it (a real, persistent local identity —
// see getOrCreateSigningIdentity), so install_bundle can tell "this
// bundle is byte-for-byte what its exporter actually produced" (the
// signature check) from "I've seen this exact publisher sign a bundle
// before" (the fingerprint — see claws-trust-store.ts) — two genuinely
// different questions. Neither implies the bundle's CONTENT is safe to
// run: that's still a human decision at install_bundle's own "dangerous"
// permission prompt, same as before.
export interface SigningIdentity {
  privateKeyPem: string;
  publicKeyPem: string;
}

export function defaultSigningIdentityPath(): string {
  return path.join(os.homedir(), ".finanfa-code", "claws-identity.json");
}

/** Loads this machine's own persistent signing identity, generating a real Ed25519 keypair the first time (never regenerated after — a stable identity is the whole point, so a bundle you exported last week and one you export today verify as the same publisher). */
export async function getOrCreateSigningIdentity(filePath: string = defaultSigningIdentityPath()): Promise<SigningIdentity> {
  try {
    const raw = await readFile(filePath, "utf-8");
    return JSON.parse(raw) as SigningIdentity;
  } catch {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const identity: SigningIdentity = {
      privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
      publicKeyPem: publicKey.export({ type: "spki", format: "pem" }) as string,
    };
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(identity, null, 2), "utf-8");
    return identity;
  }
}

/** A short, stable identifier for a public key — not the whole PEM (unwieldy to display/compare by eye), and short enough to read out or paste when deciding whether to trust a publisher. */
export function fingerprintPublicKey(publicKeyPem: string): string {
  return createHash("sha256").update(publicKeyPem).digest("hex").slice(0, 16);
}

export function signPayload(payload: string, privateKeyPem: string): string {
  return cryptoSign(null, Buffer.from(payload, "utf-8"), createPrivateKey(privateKeyPem)).toString("base64");
}

/** False for a genuinely invalid signature AND for a malformed key/signature that would otherwise throw — either way, "not verified," not a crash. */
export function verifyPayload(payload: string, signatureBase64: string, publicKeyPem: string): boolean {
  try {
    return cryptoVerify(null, Buffer.from(payload, "utf-8"), createPublicKey(publicKeyPem), Buffer.from(signatureBase64, "base64"));
  } catch {
    return false;
  }
}

/** Deterministic JSON serialization (object keys sorted recursively) — signing/verifying must hash the exact same bytes regardless of which order a bundle's `files` map happened to be built/iterated in. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    return sorted;
  }
  return value;
}
