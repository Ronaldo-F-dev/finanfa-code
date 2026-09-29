import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ToolDefinition } from "../../../core/types.js";
import { isCommandAvailable } from "../../../util/command-availability.js";
import { severityFromScore } from "./cvss.js";
import { formatScanOutput, type Finding, type PassedControl, type ScanOutput } from "./types.js";

// Local host security-posture audit — passive, read-only introspection of
// THIS machine (its own sshd_config, its own listening ports, its own
// firewall state, its own sensitive-file permissions). Deliberately
// separate from the active network/web pentest tools elsewhere in this
// directory (nmap.ts, tls.ts, sqli.ts, ...), which probe a remote target;
// nothing here sends a single network packet.
//
// Four small tools rather than one combined one: each inspects a
// completely different subsystem (a config file, process/socket state, a
// platform-specific firewall daemon, filesystem metadata) with its own
// failure mode ("file not readable" vs "binary not installed" vs "path
// doesn't exist"), so a caller very plausibly wants just one of these at a
// time. A single combined tool would either always run all four (wasteful
// when only one is wanted, and one slow/unavailable check shouldn't block
// the others) or need its own sub-selection scheme, which the multi-tool
// convention already gives us for free.

const DEFAULT_TIMEOUT_MS = 15_000;

interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
  error?: NodeJS.ErrnoException;
  timedOut?: boolean;
}

function run(bin: string, args: string[], timeoutMs: number, signal?: AbortSignal): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(bin, args);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    const onAbort = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (d) => (stdout += d));
    child.stderr?.on("data", (d) => (stderr += d));
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({ stdout, stderr, code, timedOut });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({ stdout, stderr, code: null, error: error as NodeJS.ErrnoException });
    });
  });
}

function finding(score: number, rest: Omit<Finding, "severity" | "cvssScore">): Finding {
  return { ...rest, severity: severityFromScore(score), cvssScore: score };
}

// ---------------------------------------------------------------------------
// secops_audit_ssh_config
// ---------------------------------------------------------------------------

const SSHD_CONFIG_PATH = "/etc/ssh/sshd_config";

/** Parses sshd_config's "Directive value" line shape, lowercasing the directive name (sshd directives are case-insensitive) and keeping only the FIRST occurrence of each — real sshd semantics: for most directives the first obtained value wins and later duplicates in the same scope are ignored, unlike a typical "last value wins" config format. */
function parseSshdConfig(text: string): Map<string, string> {
  const directives = new Map<string, string>();
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(\S+)\s+(.+)$/.exec(line);
    if (!match) continue;
    const key = match[1]!.toLowerCase();
    if (!directives.has(key)) directives.set(key, match[2]!.trim());
  }
  return directives;
}

function auditSshdConfig(directives: Map<string, string>): ScanOutput {
  const findings: Finding[] = [];
  const passed: PassedControl[] = [];

  const protocol = directives.get("protocol");
  if (protocol && protocol.split(",").map((v) => v.trim()).includes("1")) {
    findings.push(
      finding(9.8, {
        id: "ssh-protocol-1-enabled",
        title: "SSHv1 Protocol Enabled",
        cvssVector: "AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H",
        cwe: "CWE-327",
        description: `sshd_config sets 'Protocol ${protocol}', which includes SSHv1 — a badly broken protocol with known plaintext-recovery and MITM attacks.`,
        evidence: `Protocol ${protocol}`,
        impact: "SSHv1 sessions can be decrypted or hijacked by an on-path attacker; this is not a theoretical weakness.",
        remediation: "Remove the Protocol directive entirely (modern OpenSSH only speaks SSHv2) or set 'Protocol 2' explicitly.",
      }),
    );
  }

  const permitRootLogin = directives.get("permitrootlogin")?.toLowerCase();
  if (permitRootLogin === "yes") {
    findings.push(
      finding(8.1, {
        id: "ssh-permit-root-login-yes",
        title: "Root Login Permitted Over SSH",
        cvssVector: "AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:N",
        cwe: "CWE-284",
        description: "sshd_config sets 'PermitRootLogin yes', allowing direct root login over SSH (password or key).",
        evidence: "PermitRootLogin yes",
        impact: "A compromised root credential or key gives an attacker full, direct root access with no privilege-escalation step needed.",
        remediation: "Set 'PermitRootLogin no' (or 'prohibit-password' if root key-based access is genuinely required) and use sudo for admin access instead.",
      }),
    );
  } else if (permitRootLogin === "no" || permitRootLogin === "prohibit-password" || permitRootLogin === "without-password") {
    passed.push({ label: "PermitRootLogin", detail: `Set to '${permitRootLogin}' — direct root password login is not permitted.` });
  } else if (!permitRootLogin) {
    findings.push(
      finding(5.3, {
        id: "ssh-permit-root-login-unset",
        title: "PermitRootLogin Not Explicitly Set",
        cvssVector: "AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:L/A:N",
        cwe: "CWE-284",
        description: "sshd_config has no explicit PermitRootLogin directive. The compiled-in OpenSSH default is 'prohibit-password' on recent versions but was 'yes' on older ones — don't rely on the default.",
        evidence: "No PermitRootLogin directive found",
        impact: "Behavior depends on the exact sshd version/build, which is fragile and easy to get wrong across upgrades.",
        remediation: "Set PermitRootLogin explicitly to 'no' or 'prohibit-password'.",
      }),
    );
  }

  const passwordAuth = directives.get("passwordauthentication")?.toLowerCase();
  if (passwordAuth === "yes" || !passwordAuth) {
    // Absent defaults to 'yes' in stock OpenSSH — flagged the same as an explicit
    // 'yes', with context: whether this is actually a problem depends on the
    // deployment (a box that only ever expects key-based auth should disable
    // it; one that intentionally supports password auth for interactive users
    // may accept this consciously). Not assuming the "right" answer either way.
    findings.push(
      finding(5.3, {
        id: "ssh-password-authentication-enabled",
        title: "Password Authentication Enabled",
        cvssVector: "AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:L/A:N",
        cwe: "CWE-521",
        description: passwordAuth
          ? "sshd_config sets 'PasswordAuthentication yes'."
          : "No PasswordAuthentication directive found; the OpenSSH default is 'yes'.",
        evidence: passwordAuth ? "PasswordAuthentication yes" : "No PasswordAuthentication directive found (default: yes)",
        impact: "Password auth is subject to brute-force/credential-stuffing; whether this is acceptable depends on the deployment (e.g. if key-based auth is meant to be the only path in, this should be disabled).",
        remediation: "If key-based auth is the intended norm for this host, set 'PasswordAuthentication no' and confirm key-based access works before disabling it.",
      }),
    );
  } else {
    passed.push({ label: "PasswordAuthentication", detail: "Set to 'no' — password-based login is disabled." });
  }

  const permitEmpty = directives.get("permitemptypasswords")?.toLowerCase();
  if (permitEmpty === "yes") {
    findings.push(
      finding(9.1, {
        id: "ssh-permit-empty-passwords",
        title: "Empty Passwords Permitted",
        cvssVector: "AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:N",
        cwe: "CWE-258",
        description: "sshd_config sets 'PermitEmptyPasswords yes', allowing login with a blank password for any account that has one.",
        evidence: "PermitEmptyPasswords yes",
        impact: "Any account with an empty password can be logged into by anyone — trivial unauthenticated access.",
        remediation: "Set 'PermitEmptyPasswords no' (this should always be 'no').",
      }),
    );
  } else {
    passed.push({ label: "PermitEmptyPasswords", detail: `Set to '${permitEmpty ?? "no (default)"}' — empty-password login is not permitted.` });
  }

  return { findings, passedControls: passed };
}

interface SecopsAuditSshConfigInput {
  path?: string;
}

export function createSecopsAuditSshConfigTool(): ToolDefinition<SecopsAuditSshConfigInput> {
  return {
    name: "secops_audit_ssh_config",
    description:
      "Security tool. Reads and parses the real local sshd_config (default /etc/ssh/sshd_config) and flags real " +
      "hardening gaps: SSHv1 enabled (critical), root login permitted, password authentication enabled (flagged " +
      "with context either way — whether disabling it is right depends on the deployment), and empty passwords " +
      "permitted (critical). Read-only — never modifies the file. Reports clearly if the file doesn't exist or " +
      "isn't readable (e.g. non-root on macOS) rather than crashing.",
    riskLevel: "safe",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: `Path to sshd_config (default ${SSHD_CONFIG_PATH})` } },
    },
    describeCall: (input) => `audit sshd_config: ${input.path ?? SSHD_CONFIG_PATH}`,
    async handler(input) {
      const configPath = input.path ?? SSHD_CONFIG_PATH;
      let text: string;
      try {
        text = await fs.readFile(configPath, "utf8");
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          return { content: `${configPath} does not exist on this host — nothing to audit.`, isError: false };
        }
        if (code === "EACCES") {
          return { content: `${configPath} exists but isn't readable by the current user (permission denied) — re-run with elevated read access to audit it.`, isError: false };
        }
        return { content: `Failed to read ${configPath}: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
      const output = auditSshdConfig(parseSshdConfig(text));
      return { content: formatScanOutput(configPath, output), isError: false };
    },
  };
}

// ---------------------------------------------------------------------------
// secops_audit_open_ports
// ---------------------------------------------------------------------------

interface PortEntry {
  proto: string;
  port: string;
  address: string;
  process: string;
}

/** Parses `lsof -iTCP -sTCP:LISTEN -P -n` / `lsof -iUDP -P -n` output. Columns: COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME — NAME is e.g. "127.0.0.1:8080 (LISTEN)" or "*:5353". */
function parseLsofOutput(stdout: string, proto: string): PortEntry[] {
  const lines = stdout.split("\n").slice(1); // drop header row
  const entries: PortEntry[] = [];
  for (const line of lines) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 9) continue;
    const command = cols[0]!;
    const pid = cols[1]!;
    const name = cols[8]!;
    const addrMatch = /^(.+):(\d+)/.exec(name.replace(/\s*\(LISTEN\)$/, ""));
    if (!addrMatch) continue;
    entries.push({ proto, port: addrMatch[2]!, address: addrMatch[1]!, process: `${command} (pid ${pid})` });
  }
  return entries;
}

/** Fallback parser for `netstat -an` (BSD/macOS syntax: Proto Recv-Q Send-Q Local-Address Foreign-Address (State)). netstat alone can't map a socket back to a process name/PID the way lsof can, so entries are reported as "unknown" for that field rather than guessed. */
function parseNetstatOutput(stdout: string): PortEntry[] {
  const entries: PortEntry[] = [];
  for (const line of stdout.split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4) continue;
    const proto = cols[0]!;
    if (!proto.startsWith("tcp") && !proto.startsWith("udp")) continue;
    if (proto.startsWith("tcp") && cols[5] !== "LISTEN") continue;
    const local = cols[3]!;
    const lastColon = local.lastIndexOf(".") !== -1 ? local.lastIndexOf(".") : local.lastIndexOf(":");
    if (lastColon === -1) continue;
    entries.push({ proto, port: local.slice(lastColon + 1), address: local.slice(0, lastColon), process: "unknown (netstat doesn't report process names)" });
  }
  return entries;
}

function formatPortEntries(entries: PortEntry[]): string {
  if (entries.length === 0) return "No listening ports found.";
  const lines = [`${entries.length} listening port(s):`, ""];
  for (const e of entries) lines.push(`${e.proto.toUpperCase().padEnd(4)} ${e.address}:${e.port}  ${e.process}`);
  return lines.join("\n");
}

export interface SecopsAuditOpenPortsOptions {
  lsofBinary?: string;
  netstatBinary?: string;
}

export function createSecopsAuditOpenPortsTool(options: SecopsAuditOpenPortsOptions = {}): ToolDefinition<Record<string, never>> {
  const lsofBin = options.lsofBinary ?? "lsof";
  const netstatBin = options.netstatBinary ?? "netstat";
  return {
    name: "secops_audit_open_ports",
    description:
      "Security tool. Lists real, currently-listening TCP/UDP ports on this local machine with the process " +
      "bound to each, using `lsof -iTCP -sTCP:LISTEN -P -n` / `lsof -iUDP -P -n` (falling back to `netstat -an` " +
      "if lsof isn't installed, though netstat can't report the owning process name). Pure inventory, not a " +
      "finding — a listening port isn't inherently a problem, deciding which ports SHOULD be open on this host " +
      "is a judgment call for whoever reads the list.",
    riskLevel: "safe",
    inputSchema: { type: "object", properties: {} },
    describeCall: () => "list locally listening TCP/UDP ports",
    async handler(_input, ctx) {
      if (isCommandAvailable(lsofBin)) {
        const [tcp, udp] = await Promise.all([
          run(lsofBin, ["-iTCP", "-sTCP:LISTEN", "-P", "-n"], DEFAULT_TIMEOUT_MS, ctx.signal),
          run(lsofBin, ["-iUDP", "-P", "-n"], DEFAULT_TIMEOUT_MS, ctx.signal),
        ]);
        if (tcp.error && udp.error) {
          return { content: `Failed to run lsof: ${tcp.error.message}`, isError: true };
        }
        const entries = [...parseLsofOutput(tcp.stdout, "tcp"), ...parseLsofOutput(udp.stdout, "udp")];
        return { content: formatPortEntries(entries), isError: false };
      }
      if (isCommandAvailable(netstatBin)) {
        const result = await run(netstatBin, ["-an"], DEFAULT_TIMEOUT_MS, ctx.signal);
        if (result.error) {
          return { content: `Failed to run netstat: ${result.error.message}`, isError: true };
        }
        const entries = parseNetstatOutput(result.stdout);
        return { content: `(via netstat fallback — lsof not installed)\n${formatPortEntries(entries)}`, isError: false };
      }
      return { content: "Neither lsof nor netstat is available on this host — cannot list listening ports.", isError: true };
    },
  };
}

// ---------------------------------------------------------------------------
// secops_audit_firewall_status
// ---------------------------------------------------------------------------

export interface SecopsAuditFirewallStatusOptions {
  socketfilterfwBinary?: string;
  ufwBinary?: string;
  firewallCmdBinary?: string;
  /** Test-only: overrides process.platform's darwin/linux/other branch. */
  platform?: NodeJS.Platform;
}

export function createSecopsAuditFirewallStatusTool(options: SecopsAuditFirewallStatusOptions = {}): ToolDefinition<Record<string, never>> {
  const socketfilterfwBin = options.socketfilterfwBinary ?? "/usr/libexec/ApplicationFirewall/socketfilterfw";
  const ufwBin = options.ufwBinary ?? "ufw";
  const firewallCmdBin = options.firewallCmdBinary ?? "firewall-cmd";
  const platform = options.platform ?? process.platform;
  return {
    name: "secops_audit_firewall_status",
    description:
      "Security tool. Checks the real local firewall manager's state: on macOS, " +
      "`/usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate` (the Application Firewall); on Linux, " +
      "`ufw status` if ufw is installed, else `firewall-cmd --state` if firewalld is installed. Reports a clear " +
      "'no recognized firewall manager found' if none of these apply on this host.",
    riskLevel: "safe",
    inputSchema: { type: "object", properties: {} },
    describeCall: () => "check local firewall status",
    async handler(_input, ctx) {
      if (platform === "darwin") {
        const result = await run(socketfilterfwBin, ["--getglobalstate"], DEFAULT_TIMEOUT_MS, ctx.signal);
        if (result.error) {
          return { content: `Failed to query the macOS Application Firewall (${socketfilterfwBin}): ${result.error.message}`, isError: true };
        }
        return { content: `macOS Application Firewall: ${result.stdout.trim() || result.stderr.trim()}`, isError: false };
      }

      if (isCommandAvailable(ufwBin)) {
        const result = await run(ufwBin, ["status"], DEFAULT_TIMEOUT_MS, ctx.signal);
        if (result.error) {
          return { content: `Failed to run 'ufw status': ${result.error.message}`, isError: true };
        }
        return { content: `ufw: ${result.stdout.trim() || result.stderr.trim()}`, isError: false };
      }
      if (isCommandAvailable(firewallCmdBin)) {
        const result = await run(firewallCmdBin, ["--state"], DEFAULT_TIMEOUT_MS, ctx.signal);
        if (result.error) {
          return { content: `Failed to run 'firewall-cmd --state': ${result.error.message}`, isError: true };
        }
        return { content: `firewalld: ${result.stdout.trim() || result.stderr.trim()}`, isError: false };
      }
      return { content: "No recognized firewall manager found (checked: macOS Application Firewall, ufw, firewalld).", isError: false };
    },
  };
}

// ---------------------------------------------------------------------------
// secops_audit_file_permissions
// ---------------------------------------------------------------------------

const SENSITIVE_PATHS = [".ssh/id_rsa", ".ssh/id_ed25519", ".aws/credentials", ".kube/config"];

function auditFilePermission(relPath: string, absPath: string, mode: number): Finding | PassedControl {
  const perms = (mode & 0o777).toString(8);
  const groupOrOtherAccess = mode & 0o077; // any group/other read/write/execute bit
  if (groupOrOtherAccess !== 0) {
    return finding(6.5, {
      id: "secops-file-permissions-too-open",
      title: `Sensitive File Readable/Writable by Group or Other (${relPath})`,
      cvssVector: "AV:L/AC:L/PR:L/UI:N/S:U/C:H/I:L/A:N",
      cwe: "CWE-732",
      description: `${absPath} has mode ${perms} — other local users on this machine can read or write it.`,
      evidence: `mode ${perms}`,
      impact: "Any other local account (or a compromised low-privilege process) can read this credential/key material directly off disk.",
      remediation: `Run 'chmod 600 "${absPath}"' (or 700 for a directory) to restrict access to the owner only.`,
      affectedEndpoint: absPath,
    });
  }
  return { label: relPath, detail: `${absPath} is mode ${perms} — not accessible to group/other.` };
}

export interface SecopsAuditFilePermissionsOptions {
  /** Test-only: overrides os.homedir() so tests can point at a temp "~/.ssh"-shaped directory instead of the real home directory. */
  homeDir?: string;
}

export function createSecopsAuditFilePermissionsTool(options: SecopsAuditFilePermissionsOptions = {}): ToolDefinition<Record<string, never>> {
  return {
    name: "secops_audit_file_permissions",
    description:
      "Security tool. Stats a fixed list of sensitive local paths if they exist (~/.ssh/id_rsa, " +
      "~/.ssh/id_ed25519, ~/.aws/credentials, ~/.kube/config) and flags any that are group- or other-readable/" +
      "writable (should be mode 600). Skips any path that doesn't exist. Read-only — never changes permissions.",
    riskLevel: "safe",
    inputSchema: { type: "object", properties: {} },
    describeCall: () => "audit permissions on sensitive local files (~/.ssh, ~/.aws, ~/.kube)",
    async handler() {
      const home = options.homeDir ?? os.homedir();
      const findings: Finding[] = [];
      const passed: PassedControl[] = [];
      let checked = 0;

      for (const rel of SENSITIVE_PATHS) {
        const abs = path.join(home, rel);
        let stat;
        try {
          stat = await fs.stat(abs);
        } catch {
          continue; // doesn't exist — nothing to check, skip gracefully
        }
        checked++;
        const result = auditFilePermission(rel, abs, stat.mode);
        if ("severity" in result) findings.push(result);
        else passed.push(result);
      }

      if (checked === 0) {
        return { content: "None of the checked sensitive paths exist on this host (~/.ssh/id_rsa, ~/.ssh/id_ed25519, ~/.aws/credentials, ~/.kube/config).", isError: false };
      }
      return { content: formatScanOutput(home, { findings, passedControls: passed }), isError: false };
    },
  };
}

export function createSecopsAuditTools(): ToolDefinition[] {
  return [
    createSecopsAuditSshConfigTool(),
    createSecopsAuditOpenPortsTool(),
    createSecopsAuditFirewallStatusTool(),
    createSecopsAuditFilePermissionsTool(),
  ];
}
