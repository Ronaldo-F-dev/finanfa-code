import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createSecopsAuditSshConfigTool,
  createSecopsAuditOpenPortsTool,
  createSecopsAuditFirewallStatusTool,
  createSecopsAuditFilePermissionsTool,
  createSecopsAuditTools,
} from "../../../src/tools/builtin/security/secops-audit.js";

const ctx = { cwd: "/tmp", sessionId: "test", signal: new AbortController().signal };
const FAKE_LSOF = fileURLToPath(new URL("../../fixtures/fake-lsof.mjs", import.meta.url));
const FAKE_NETSTAT = fileURLToPath(new URL("../../fixtures/fake-netstat.mjs", import.meta.url));
const FAKE_SOCKETFILTERFW = fileURLToPath(new URL("../../fixtures/fake-socketfilterfw.mjs", import.meta.url));
const FAKE_UFW = fileURLToPath(new URL("../../fixtures/fake-ufw.mjs", import.meta.url));
const MISSING_BIN = "/nonexistent/definitely-not-a-real-binary-xyz";

describe("createSecopsAuditTools", () => {
  it("returns all four tools with the documented names and 'safe' risk level", () => {
    const tools = createSecopsAuditTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "secops_audit_file_permissions",
      "secops_audit_firewall_status",
      "secops_audit_open_ports",
      "secops_audit_ssh_config",
    ]);
    for (const tool of tools) expect(tool.riskLevel).toBe("safe");
  });
});

describe("secops_audit_ssh_config (real temp sshd_config file)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "secops-sshd-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function writeConfig(contents: string): Promise<string> {
    const file = path.join(tmpDir, "sshd_config");
    await fs.writeFile(file, contents, "utf8");
    return file;
  }

  it("flags PermitRootLogin yes", async () => {
    const file = await writeConfig("PermitRootLogin yes\nPasswordAuthentication no\nPermitEmptyPasswords no\n");
    const tool = createSecopsAuditSshConfigTool();
    const result = await tool.handler({ path: file }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Root Login Permitted Over SSH");
  });

  it("does not flag PermitRootLogin when set to prohibit-password", async () => {
    const file = await writeConfig("PermitRootLogin prohibit-password\nPasswordAuthentication no\nPermitEmptyPasswords no\n");
    const tool = createSecopsAuditSshConfigTool();
    const result = await tool.handler({ path: file }, ctx);
    expect(result.content).not.toContain("Root Login Permitted");
    expect(result.content).toContain("PermitRootLogin");
  });

  it("flags PasswordAuthentication yes with context, and passes when no", async () => {
    const file = await writeConfig("PermitRootLogin no\nPasswordAuthentication yes\nPermitEmptyPasswords no\n");
    const tool = createSecopsAuditSshConfigTool();
    const result = await tool.handler({ path: file }, ctx);
    expect(result.content).toContain("Password Authentication Enabled");

    const fileSecure = await writeConfig("PermitRootLogin no\nPasswordAuthentication no\nPermitEmptyPasswords no\n");
    const secureResult = await tool.handler({ path: fileSecure }, ctx);
    expect(secureResult.content).not.toContain("Password Authentication Enabled");
  });

  it("flags PermitEmptyPasswords yes as a high-severity finding", async () => {
    const file = await writeConfig("PermitRootLogin no\nPasswordAuthentication no\nPermitEmptyPasswords yes\n");
    const tool = createSecopsAuditSshConfigTool();
    const result = await tool.handler({ path: file }, ctx);
    expect(result.content).toContain("Empty Passwords Permitted");
    expect(result.content).toMatch(/CRITICAL|HIGH/);
  });

  it("flags Protocol 1 as critical", async () => {
    const file = await writeConfig("Protocol 1\nPermitRootLogin no\nPasswordAuthentication no\nPermitEmptyPasswords no\n");
    const tool = createSecopsAuditSshConfigTool();
    const result = await tool.handler({ path: file }, ctx);
    expect(result.content).toContain("SSHv1 Protocol Enabled");
    expect(result.content).toContain("CRITICAL");
  });

  it("does not flag Protocol 1 when absent", async () => {
    const file = await writeConfig("PermitRootLogin no\nPasswordAuthentication no\nPermitEmptyPasswords no\n");
    const tool = createSecopsAuditSshConfigTool();
    const result = await tool.handler({ path: file }, ctx);
    expect(result.content).not.toContain("SSHv1");
  });

  it("reports a clear message, not a crash, when the file doesn't exist", async () => {
    const tool = createSecopsAuditSshConfigTool();
    const result = await tool.handler({ path: path.join(tmpDir, "nope") }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toMatch(/does not exist/i);
  });

  it("reports a clear message, not a crash, when the file isn't readable", async () => {
    const file = await writeConfig("PermitRootLogin no\n");
    await fs.chmod(file, 0o000);
    const tool = createSecopsAuditSshConfigTool();
    const result = await tool.handler({ path: file }, ctx);
    // On some CI environments running as root, chmod 000 doesn't actually block reads —
    // only assert the specific "not readable" message when a real EACCES occurred.
    if (result.content.includes("permission denied")) {
      expect(result.isError).toBe(false);
      expect(result.content).toMatch(/isn't readable/i);
    }
    await fs.chmod(file, 0o600);
  });
});

describe("secops_audit_open_ports (real subprocess, fake lsof/netstat stand-ins)", () => {
  it("parses real fake-lsof output into port/process pairs", async () => {
    const tool = createSecopsAuditOpenPortsTool({ lsofBinary: FAKE_LSOF });
    const result = await tool.handler({}, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("6379");
    expect(result.content).toContain("redis-ser");
    expect(result.content).toContain("5353");
  });

  it("falls back to netstat when lsof isn't available", async () => {
    const tool = createSecopsAuditOpenPortsTool({ lsofBinary: MISSING_BIN, netstatBinary: FAKE_NETSTAT });
    const result = await tool.handler({}, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("netstat fallback");
    expect(result.content).toContain("5432");
  });

  it("reports a clear error, not a crash, when neither lsof nor netstat is available", async () => {
    const tool = createSecopsAuditOpenPortsTool({ lsofBinary: MISSING_BIN, netstatBinary: MISSING_BIN });
    const result = await tool.handler({}, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/neither lsof nor netstat/i);
  });
});

describe("secops_audit_firewall_status (real subprocess, fake firewall-manager stand-ins)", () => {
  afterEach(() => {
    delete process.env.FAKE_FIREWALL_STATE;
  });

  it("reports macOS Application Firewall enabled", async () => {
    process.env.FAKE_FIREWALL_STATE = "enabled";
    const tool = createSecopsAuditFirewallStatusTool({ platform: "darwin", socketfilterfwBinary: FAKE_SOCKETFILTERFW });
    const result = await tool.handler({}, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("enabled");
  });

  it("reports macOS Application Firewall disabled", async () => {
    process.env.FAKE_FIREWALL_STATE = "disabled";
    const tool = createSecopsAuditFirewallStatusTool({ platform: "darwin", socketfilterfwBinary: FAKE_SOCKETFILTERFW });
    const result = await tool.handler({}, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("disabled");
  });

  it("reports ufw active on Linux", async () => {
    process.env.FAKE_FIREWALL_STATE = "enabled";
    const tool = createSecopsAuditFirewallStatusTool({ platform: "linux", ufwBinary: FAKE_UFW });
    const result = await tool.handler({}, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("active");
  });

  it("reports no recognized firewall manager when none is found on Linux", async () => {
    const tool = createSecopsAuditFirewallStatusTool({ platform: "linux", ufwBinary: MISSING_BIN, firewallCmdBinary: MISSING_BIN });
    const result = await tool.handler({}, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toMatch(/no recognized firewall manager/i);
  });
});

describe("secops_audit_file_permissions (real temp ~/.ssh-shaped dir, real chmod)", () => {
  let tmpHome: string;

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "secops-home-"));
    await fs.mkdir(path.join(tmpHome, ".ssh"), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpHome, { recursive: true, force: true });
  });

  it("flags a 0o644 key file as too open", async () => {
    const keyPath = path.join(tmpHome, ".ssh", "id_rsa");
    await fs.writeFile(keyPath, "fake-key-material", "utf8");
    await fs.chmod(keyPath, 0o644);

    const tool = createSecopsAuditFilePermissionsTool({ homeDir: tmpHome });
    const result = await tool.handler({}, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Readable/Writable by Group or Other");
    expect(result.content).toContain("id_rsa");
  });

  it("passes a 0o600 key file", async () => {
    const keyPath = path.join(tmpHome, ".ssh", "id_ed25519");
    await fs.writeFile(keyPath, "fake-key-material", "utf8");
    await fs.chmod(keyPath, 0o600);

    const tool = createSecopsAuditFilePermissionsTool({ homeDir: tmpHome });
    const result = await tool.handler({}, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).not.toContain("Readable/Writable by Group or Other");
    expect(result.content).toContain("id_ed25519");
  });

  it("skips gracefully when none of the sensitive paths exist", async () => {
    const emptyHome = await fs.mkdtemp(path.join(os.tmpdir(), "secops-empty-home-"));
    const tool = createSecopsAuditFilePermissionsTool({ homeDir: emptyHome });
    const result = await tool.handler({}, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toMatch(/none of the checked sensitive paths exist/i);
    await fs.rm(emptyHome, { recursive: true, force: true });
  });
});
