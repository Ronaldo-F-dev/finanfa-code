import { spawn } from "node:child_process";
import { readFile, access } from "node:fs/promises";
import path from "node:path";
import type { ToolDefinition } from "../../core/types.js";
import { killProcessGroup } from "../../util/process.js";

const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_BUFFER = 100_000; // bytes per stream

function truncate(s: string): string {
  return s.length > MAX_BUFFER ? `${s.slice(0, MAX_BUFFER)}\n... (truncated)` : s;
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function nodePackageManager(cwd: string): Promise<string> {
  if (await exists(path.join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (await exists(path.join(cwd, "yarn.lock"))) return "yarn";
  return "npm";
}

/**
 * Picks a test command by looking for the usual project markers, in the
 * order a developer would check them. Returns undefined if nothing was
 * recognized — the caller should ask for an explicit `command` instead of
 * guessing.
 */
export async function detectTestCommand(cwd: string): Promise<string | undefined> {
  const packageJsonPath = path.join(cwd, "package.json");
  if (await exists(packageJsonPath)) {
    try {
      const pkg = JSON.parse(await readFile(packageJsonPath, "utf-8")) as { scripts?: Record<string, string> };
      const testScript = pkg.scripts?.test;
      // npm init's placeholder script always fails on purpose — not a real test suite.
      if (testScript && !testScript.includes("Error: no test specified")) {
        const pm = await nodePackageManager(cwd);
        return `${pm} test`;
      }
    } catch {
      // Malformed package.json — fall through to other detectors.
    }
  }

  if (
    (await exists(path.join(cwd, "pyproject.toml"))) ||
    (await exists(path.join(cwd, "pytest.ini"))) ||
    (await exists(path.join(cwd, "setup.py")))
  ) {
    return "pytest";
  }

  if (await exists(path.join(cwd, "Cargo.toml"))) return "cargo test";
  if (await exists(path.join(cwd, "go.mod"))) return "go test ./...";

  return undefined;
}

function runCommand(command: string, cwd: string, timeoutMs: number): Promise<{ content: string; isError: boolean }> {
  return new Promise((resolve) => {
    // detached: true — see killProcessGroup: a test script that backgrounds
    // a server/watcher without redirecting its output would otherwise hold
    // the stdio pipe open forever, past a plain kill of just the shell.
    const child = spawn(command, { cwd, shell: true, detached: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessGroup(child);
    }, timeoutMs);

    child.stdout?.on("data", (d) => (stdout += d));
    child.stderr?.on("data", (d) => (stderr += d));

    child.on("close", (code) => {
      clearTimeout(timer);
      const header = timedOut ? `(timed out after ${timeoutMs}ms)\n` : `(exit code ${code})\n`;
      const content = `${header}--- stdout ---\n${truncate(stdout)}\n--- stderr ---\n${truncate(stderr)}`;
      resolve({ content, isError: timedOut || code !== 0 });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ content: `Failed to start "${command}": ${err.message}`, isError: true });
    });
  });
}

interface RunTestsInput {
  command?: string;
  timeout_ms?: number;
}

export const runTestsTool: ToolDefinition<RunTestsInput> = {
  name: "run_tests",
  description:
    "Run the project's test suite and report pass/fail with the output. Auto-detects the command " +
    "(npm/pnpm/yarn test, pytest, cargo test, go test) from project files unless `command` is given. " +
    "Use this after making a code change, then read the failures and fix them before re-running.",
  riskLevel: "ask",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "Explicit test command to run, overriding auto-detection" },
      timeout_ms: { type: "number", description: "Timeout in milliseconds (default 300000)" },
    },
  },
  describeCall: (input) => input.command ?? "run tests (auto-detected)",
  async handler(input, ctx) {
    const command = input.command ?? (await detectTestCommand(ctx.cwd));
    if (!command) {
      return {
        content:
          "No test command could be detected (no package.json test script, pytest/Cargo/go project found). " +
          "Pass `command` explicitly.",
        isError: true,
      };
    }
    return runCommand(command, ctx.cwd, input.timeout_ms ?? DEFAULT_TIMEOUT_MS);
  },
};
