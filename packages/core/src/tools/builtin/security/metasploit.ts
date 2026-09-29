import { spawn } from "node:child_process";
import type { ToolDefinition } from "../../../core/types.js";
import { isCommandAvailable } from "../../../util/command-availability.js";

// Real Metasploit Framework integration — a genuinely bigger step up than
// every other tool in this directory: msfconsole can load and run actual
// exploit modules, not just probe/report exposure. Wrapped via
// msfconsole's one-shot resource-script mode (`-q -x "<cmd>; <cmd>; ..."`)
// rather than the RPC daemon (msfrpcd + msgpack API) because that needs a
// separately-running daemon and credentials the agent has no story for
// provisioning — `-x` works against a plain local msfcli install exactly
// like docker/kubectl/adb do, no extra setup beyond having the binary.
// Only registered when msfconsole is actually installed (isCommandAvailable
// gating in index.ts).
const DEFAULT_TIMEOUT_MS = 300_000; // an exploit/auxiliary run against a real target can run long

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

export interface RunMetasploitOptions {
  msfconsoleBinary?: string;
}

interface SecurityRunMetasploitInput {
  commands: string[];
  timeoutMs?: number;
}

export function createSecurityRunMetasploitTool(options: RunMetasploitOptions = {}): ToolDefinition<SecurityRunMetasploitInput> {
  const msfconsoleBin = options.msfconsoleBinary ?? "msfconsole";

  return {
    name: "security_run_metasploit",
    description:
      "Security tool. Runs a sequence of real msfconsole commands (e.g. ['use auxiliary/scanner/portscan/tcp', " +
      "'set RHOSTS 10.0.0.5', 'set PORTS 1-1000', 'run']) via `msfconsole -q -x \"<cmds joined by ;>\"` and " +
      "returns the real captured console output. This is the actual Metasploit Framework, not a simulation: " +
      "it can load and run real exploit and auxiliary modules — port/service scanners, vulnerability checks, " +
      "and actual exploit modules that gain code execution or otherwise compromise a target, including staged " +
      "payloads (e.g. 'set PAYLOAD ...', 'exploit'). " +
      "IMPORTANT: only ever use this against a host the user owns or has clear, explicit, documented " +
      "authorization to test — unlike the scanner tools in this directory, an exploit module run here performs " +
      "a real attack action against the target (not just a probe), which is illegal and harmful against " +
      "anything else. Confirm scope and authorization before running anything beyond a read-only scanner " +
      "module.",
    riskLevel: "dangerous",
    inputSchema: {
      type: "object",
      properties: {
        commands: { type: "array", items: { type: "string" }, description: "msfconsole commands to run in order, e.g. ['use auxiliary/scanner/portscan/tcp', 'set RHOSTS 10.0.0.5', 'run']" },
        timeoutMs: { type: "number", description: `Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS} — exploit/scanner runs can take a while)` },
      },
      required: ["commands"],
    },
    describeCall: (input) => `msfconsole -x "${input.commands.join("; ")}"`,
    async handler(input, ctx) {
      if (!isCommandAvailable(msfconsoleBin)) {
        return { content: "msfconsole not available — install the Metasploit Framework (https://www.metasploit.com/) and ensure `msfconsole` is on PATH.", isError: true };
      }
      const commandString = input.commands.join("; ");
      const result = await run(msfconsoleBin, ["-q", "-x", commandString], input.timeoutMs ?? DEFAULT_TIMEOUT_MS, ctx.signal);
      if (result.error) {
        return { content: `Failed to run msfconsole: ${result.error.message}`, isError: true };
      }
      const header = result.timedOut ? `(timed out after ${input.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms)\n` : `(exit code ${result.code})\n`;
      const content = `${header}${result.stdout}${result.stderr ? `\n--- stderr ---\n${result.stderr}` : ""}`;
      return { content, isError: result.timedOut || result.code !== 0 };
    },
  };
}
