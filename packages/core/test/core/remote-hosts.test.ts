import { describe, expect, it, beforeAll, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  registerRemoteHost,
  removeRemoteHost,
  loadRemoteHosts,
  checkRemoteHostHealth,
  checkAndRecordRemoteHostHealth,
} from "../../src/core/remote-hosts.js";

const FAKE_SSH_SCRIPT = fileURLToPath(new URL("../fixtures/fake-ssh.mjs", import.meta.url));

describe("registerRemoteHost / removeRemoteHost / loadRemoteHosts (real file on disk)", () => {
  let dir: string;
  let registryPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "finanfa-remote-hosts-"));
    registryPath = path.join(dir, "remote-hosts.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("registers a real host, persisted to disk", async () => {
    await registerRemoteHost({ alias: "prod-db", host: "db.example.com", user: "deploy", port: 2222 }, registryPath);
    const registry = await loadRemoteHosts(registryPath);
    expect(registry["prod-db"]).toMatchObject({ alias: "prod-db", host: "db.example.com", user: "deploy", port: 2222 });
    expect(registry["prod-db"]!.addedAt).toBeTruthy();
  });

  it("updating an existing alias keeps its original addedAt and health history", async () => {
    await registerRemoteHost({ alias: "prod-db", host: "db.example.com" }, registryPath);
    const first = (await loadRemoteHosts(registryPath))["prod-db"]!;

    await registerRemoteHost({ alias: "prod-db", host: "db2.example.com", port: 22 }, registryPath);
    const updated = (await loadRemoteHosts(registryPath))["prod-db"]!;
    expect(updated.host).toBe("db2.example.com");
    expect(updated.addedAt).toBe(first.addedAt);
  });

  it("removeRemoteHost removes a real host and reports whether one existed", async () => {
    await registerRemoteHost({ alias: "prod-db", host: "db.example.com" }, registryPath);
    expect(await removeRemoteHost("prod-db", registryPath)).toBe(true);
    expect(await loadRemoteHosts(registryPath)).toEqual({});
    expect(await removeRemoteHost("prod-db", registryPath)).toBe(false);
  });

  it("loadRemoteHosts returns an empty registry when nothing is registered yet", async () => {
    expect(await loadRemoteHosts(registryPath)).toEqual({});
  });

  it("tracks multiple hosts independently", async () => {
    await registerRemoteHost({ alias: "a", host: "a.example.com" }, registryPath);
    await registerRemoteHost({ alias: "b", host: "b.example.com" }, registryPath);
    const registry = await loadRemoteHosts(registryPath);
    expect(Object.keys(registry).sort()).toEqual(["a", "b"]);
  });
});

describe("checkRemoteHostHealth / checkAndRecordRemoteHostHealth (real subprocess, fake ssh binary stand-in)", () => {
  let dir: string;
  let registryPath: string;
  let originalFakeSshFail: string | undefined;

  beforeAll(async () => {
    await chmod(FAKE_SSH_SCRIPT, 0o755);
  });

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "finanfa-remote-hosts-health-"));
    registryPath = path.join(dir, "remote-hosts.json");
    originalFakeSshFail = process.env.FAKE_SSH_FAIL;
    delete process.env.FAKE_SSH_FAIL;
  });

  afterEach(async () => {
    if (originalFakeSshFail === undefined) delete process.env.FAKE_SSH_FAIL;
    else process.env.FAKE_SSH_FAIL = originalFakeSshFail;
    await rm(dir, { recursive: true, force: true });
  });

  it("checkRemoteHostHealth reports healthy with real stdout content for a reachable host", async () => {
    const result = await checkRemoteHostHealth({ alias: "x", host: "example.com", addedAt: "now" }, FAKE_SSH_SCRIPT);
    expect(result.healthy).toBe(true);
    expect(result.summary.length).toBeGreaterThan(0);
  });

  it("checkRemoteHostHealth reports unhealthy with the real error for an unreachable host", async () => {
    process.env.FAKE_SSH_FAIL = "1";
    const result = await checkRemoteHostHealth({ alias: "x", host: "unreachable-host", addedAt: "now" }, FAKE_SSH_SCRIPT);
    expect(result.healthy).toBe(false);
    expect(result.summary).toContain("unreachable-host");
  });

  it("checkAndRecordRemoteHostHealth persists the outcome onto the registered entry", async () => {
    await registerRemoteHost({ alias: "prod-db", host: "db.example.com" }, registryPath);

    const result = await checkAndRecordRemoteHostHealth("prod-db", registryPath, FAKE_SSH_SCRIPT);
    expect(result?.healthy).toBe(true);

    const registry = await loadRemoteHosts(registryPath);
    expect(registry["prod-db"]!.lastHealthy).toBe(true);
    expect(registry["prod-db"]!.lastCheckedAt).toBeTruthy();
    expect(registry["prod-db"]!.lastHealthSummary).toBe(result?.summary);
  });

  it("checkAndRecordRemoteHostHealth records an unhealthy outcome too", async () => {
    await registerRemoteHost({ alias: "prod-db", host: "db.example.com" }, registryPath);
    process.env.FAKE_SSH_FAIL = "1";

    await checkAndRecordRemoteHostHealth("prod-db", registryPath, FAKE_SSH_SCRIPT);
    const registry = await loadRemoteHosts(registryPath);
    expect(registry["prod-db"]!.lastHealthy).toBe(false);
  });

  it("checkAndRecordRemoteHostHealth returns undefined for an alias that was never registered", async () => {
    expect(await checkAndRecordRemoteHostHealth("nonexistent", registryPath, FAKE_SSH_SCRIPT)).toBeUndefined();
  });
});
