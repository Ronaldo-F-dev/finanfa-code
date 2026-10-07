import { spawn } from "node:child_process";
import type { ToolDefinition } from "../../../core/types.js";
import { isCommandAvailable } from "../../../util/command-availability.js";

// Real nmap wrapper, on top of security_scan_ports' homemade TCP
// connect-scan (port-scan.ts): that tool intentionally reimplements only
// the simplest scan type with plain sockets so it works with zero
// dependencies, but it can't do version detection (-sV), OS fingerprinting
// (-O), or NSE script scans (-sC/--script) — those need the real nmap
// binary. Only registered when nmap is actually installed (see
// isCommandAvailable gating in index.ts), same convention as
// run_kubectl/run_adb_command/run_docker for other optional CLIs.
//
// Deliberately not restricting which nmap flags are allowed (unlike, say,
// sqli.ts/xss.ts which construct specific attack payloads themselves):
// nmap itself is fundamentally a recon/scanner tool, even with -A/-sC/
// --script, and the user installing it is the trust boundary this tool
// relies on — same "wrap, don't reinvent, don't second-guess" stance as
// run_docker/run_kubectl take toward their own real CLIs. nmap's own `dos`
// NSE script category (--script dos, or a boolean script expression
// containing it, e.g. --script "dos and safe") crosses from "check what's
// exposed" into "attack" the same way sqli.ts/xss.ts's real-payload tools
// do — real, reported decision: don't hard-block it in code, since this
// tool's whole "ask" risk tier already exists to put a real confirmation
// prompt in front of exactly this kind of call; a dos-script request gets
// its own riskKey suffix so a stricter permission rule can target it
// specifically, but by default it runs the same as any other scan once
// the user explicitly confirms the prompt.
const DEFAULT_TIMEOUT_MS = 300_000; // nmap scans (especially -A/-sC/full port ranges) can run long

function extractScriptValues(args: string[]): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--script" && args[i + 1] !== undefined) values.push(args[i + 1]!);
    else if (arg.startsWith("--script=")) values.push(arg.slice("--script=".length));
  }
  return values;
}

/** Detects nmap's `dos` NSE script category, including inside a boolean script expression like "dos and safe" or "not dos". Doesn't try to catch every individual DoS-flavored script by name (nmap ships plenty of overlapping category names) — the category token itself is the easy, reliable signal. */
function isDosScriptRequest(args: string[]): boolean {
  return extractScriptValues(args).some((value) =>
    value
      .split(/[,\s()]+/)
      .map((t) => t.toLowerCase())
      .filter((t) => t && t !== "and" && t !== "or" && t !== "not")
      .includes("dos"),
  );
}

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

export interface RunNmapOptions {
  nmapBinary?: string;
}

interface SecurityRunNmapInput {
  target: string;
  args?: string[];
  timeoutMs?: number;
}

export function createSecurityRunNmapTool(options: RunNmapOptions = {}): ToolDefinition<SecurityRunNmapInput> {
  const nmapBin = options.nmapBinary ?? "nmap";

  return {
    name: "security_run_nmap",
    description:
      "Security tool. Runs the real `nmap` CLI against a target host, with the given flags, version detection " +
      "(-sV), OS detection (-O), aggressive scan (-A), port ranges (-p 1-1000), default/custom script scans " +
      "(-sC, --script <name|category|expression>), timing templates (-T4), and any other real nmap flag; " +
      "nothing here is a curated subset. Pass flags in `args` as a plain array (e.g. ['-sV', '-p', '1-1000']) " +
      "- the target is appended automatically, so don't include it in args. Unlike security_scan_ports (a " +
      "dependency-free TCP connect-scan reimplementation), this is the real nmap binary and its full real " +
      "output. " +
      "IMPORTANT: only scan a host the user owns or has explicit, documented authorization to test, this is a " +
      "real active network scan the target can log/alert on. The `dos` NSE script category (--script dos, or " +
      "any boolean script expression containing it) actually tries to crash/hang the target service, real " +
      "denial-of-service, not recon, so it still runs, but only after the user explicitly confirms this tool's " +
      "permission prompt; it is never auto-approved silently.",
    riskLevel: "ask",
    riskKey: (input) => (isDosScriptRequest(input.args ?? []) ? "security_run_nmap:dos-script" : "security_run_nmap"),
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Target hostname, IP, or CIDR range to scan" },
        args: { type: "array", items: { type: "string" }, description: "nmap flags, as a plain array, e.g. ['-sV', '-p', '22,80,443']. Don't include the target here." },
        timeoutMs: { type: "number", description: `Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}, nmap scans can run long)` },
      },
      required: ["target"],
    },
    describeCall: (input) =>
      `nmap ${(input.args ?? []).join(" ")} ${input.target}${isDosScriptRequest(input.args ?? []) ? " (dos script, real denial-of-service, requires confirmation)" : ""}`.trim(),
    async handler(input, ctx) {
      const args = input.args ?? [];
      if (!isCommandAvailable(nmapBin)) {
        return { content: "nmap not available, install nmap (e.g. `brew install nmap` / `apt install nmap`) and ensure it's on PATH.", isError: true };
      }
      const result = await run(nmapBin, [...args, input.target], input.timeoutMs ?? DEFAULT_TIMEOUT_MS, ctx.signal);
      if (result.error) {
        return { content: `Failed to run nmap: ${result.error.message}`, isError: true };
      }
      const header = result.timedOut ? `(timed out after ${input.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms)\n` : `(exit code ${result.code})\n`;
      const content = `${header}${result.stdout}${result.stderr ? `\n--- stderr ---\n${result.stderr}` : ""}`;
      return { content, isError: result.timedOut || result.code !== 0 };
    },
  };
}
