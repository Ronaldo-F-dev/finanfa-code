import { describe, expect, it, beforeAll, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createRegisterRemoteHostTool,
  createRemoveRemoteHostTool,
  createListRemoteHostsTool,
  createCheckRemoteHostHealthTool,
} from "../../src/tools/builtin/remote-hosts-tools.js";

const FAKE_SSH_SCRIPT = fileURLToPath(new URL("../fixtures/fake-ssh.mjs", import.meta.url));
const ctx = { cwd: "/tmp", sessionId: "s", signal: new AbortController().signal };

describe("remote host tools (real file on disk, fake ssh binary stand-in)", () => {
  let homeDir: string;
  let originalHome: string | undefined;
  let originalFakeSshFail: string | undefined;

  beforeAll(async () => {
    await chmod(FAKE_SSH_SCRIPT, 0o755);
  });

  beforeEach(async () => {
    homeDir = await mkdtemp(path.join(tmpdir(), "finanfa-remote-hosts-tools-home-"));
    originalHome = process.env.HOME;
    process.env.HOME = homeDir;
    originalFakeSshFail = process.env.FAKE_SSH_FAIL;
    delete process.env.FAKE_SSH_FAIL;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    if (originalFakeSshFail === undefined) delete process.env.FAKE_SSH_FAIL;
    else process.env.FAKE_SSH_FAIL = originalFakeSshFail;
    await rm(homeDir, { recursive: true, force: true });
  });

  it("register_remote_host / list_remote_hosts / remove_remote_host drive a real registry end to end", async () => {
    const registerTool = createRegisterRemoteHostTool();
    const listTool = createListRemoteHostsTool();
    const removeTool = createRemoveRemoteHostTool();

    const before = await listTool.handler({}, ctx);
    expect(before.content).toContain("No remote hosts registered");

    const registerResult = await registerTool.handler({ alias: "prod-db", host: "db.example.com", user: "deploy" }, ctx);
    expect(registerResult.isError).toBe(false);

    const afterRegister = await listTool.handler({}, ctx);
    expect(afterRegister.content).toContain("prod-db");
    expect(afterRegister.content).toContain("deploy@db.example.com");
    expect(afterRegister.content).toContain("never checked");

    const removeResult = await removeTool.handler({ alias: "prod-db" }, ctx);
    expect(removeResult.isError).toBe(false);
    const afterRemove = await listTool.handler({}, ctx);
    expect(afterRemove.content).toContain("No remote hosts registered");
  });

  it("remove_remote_host reports a clear error for an alias that doesn't exist", async () => {
    const result = await createRemoveRemoteHostTool().handler({ alias: "nonexistent" }, ctx);
    expect(result.isError).toBe(true);
  });

  it("check_remote_host_health checks a real (fake) host and list_remote_hosts then reflects it", async () => {
    await createRegisterRemoteHostTool().handler({ alias: "prod-db", host: "db.example.com" }, ctx);

    const checkTool = createCheckRemoteHostHealthTool({ binary: FAKE_SSH_SCRIPT });
    const checkResult = await checkTool.handler({ alias: "prod-db" }, ctx);
    expect(checkResult.isError).toBe(false);
    expect(checkResult.content).toContain("is healthy");

    const listResult = await createListRemoteHostsTool().handler({}, ctx);
    expect(listResult.content).toContain("healthy");
    expect(listResult.content).not.toContain("never checked");
  });

  it("check_remote_host_health reports a real unhealthy outcome", async () => {
    await createRegisterRemoteHostTool().handler({ alias: "prod-db", host: "unreachable-host" }, ctx);
    process.env.FAKE_SSH_FAIL = "1";

    const result = await createCheckRemoteHostHealthTool({ binary: FAKE_SSH_SCRIPT }).handler({ alias: "prod-db" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("unreachable");
  });

  it("check_remote_host_health reports a clear error for an unregistered alias", async () => {
    const result = await createCheckRemoteHostHealthTool({ binary: FAKE_SSH_SCRIPT }).handler({ alias: "nonexistent" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("No registered remote host");
  });

  it("has the expected risk levels: ask to register/remove, safe to list/check", () => {
    expect(createRegisterRemoteHostTool().riskLevel).toBe("ask");
    expect(createRemoveRemoteHostTool().riskLevel).toBe("ask");
    expect(createListRemoteHostsTool().riskLevel).toBe("safe");
    expect(createCheckRemoteHostHealthTool().riskLevel).toBe("safe");
  });
});
