import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// Tracks which bundle-signing public keys (by fingerprint — see
// claws-signing.ts) this machine has already seen sign a successfully-
// installed bundle. Advisory only: install_bundle still installs a
// bundle from an unknown publisher (the human already has to approve
// its own "dangerous" permission prompt either way) — this only changes
// what's SAID about it: "first time seeing this publisher" vs "you've
// installed from this publisher before," the same distinction SSH's own
// known_hosts makes for a new vs already-seen host key.
export interface TrustedPublisher {
  fingerprint: string;
  firstSeenAt: string;
  label?: string;
}

export function defaultTrustStorePath(): string {
  return path.join(os.homedir(), ".finanfa-code", "claws-trusted-publishers.json");
}

export type TrustStore = Record<string, TrustedPublisher>;

export async function loadTrustStore(filePath: string = defaultTrustStorePath()): Promise<TrustStore> {
  try {
    const raw = await readFile(filePath, "utf-8");
    return JSON.parse(raw) as TrustStore;
  } catch {
    return {};
  }
}

async function saveTrustStore(filePath: string, store: TrustStore): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  await writeFile(tmp, JSON.stringify(store, null, 2), "utf-8");
  await rename(tmp, filePath);
}

export async function isKnownPublisher(fingerprint: string, filePath: string = defaultTrustStorePath()): Promise<boolean> {
  const store = await loadTrustStore(filePath);
  return fingerprint in store;
}

/** Records `fingerprint` as seen (idempotent — a publisher already recorded keeps its original firstSeenAt/label unless `label` is explicitly given again). */
export async function recordPublisherSeen(fingerprint: string, label?: string, filePath: string = defaultTrustStorePath()): Promise<void> {
  const store = await loadTrustStore(filePath);
  if (store[fingerprint]) {
    if (label) store[fingerprint] = { ...store[fingerprint], label };
    else return;
  } else {
    store[fingerprint] = { fingerprint, firstSeenAt: new Date().toISOString(), label };
  }
  await saveTrustStore(filePath, store);
}
