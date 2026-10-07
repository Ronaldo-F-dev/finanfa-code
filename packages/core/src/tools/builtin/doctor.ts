import { readFile, writeFile, stat, chmod, access } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fg from "fast-glob";
import type { ToolDefinition, ToolContext } from "../../core/types.js";
import { runSubprocess } from "../../util/process.js";
import { isCommandAvailable } from "../../util/command-availability.js";
import { resolveAllowedPath } from "./path-guard.js";

// Rule-based project-health "doctor" — every check below is a concrete,
// verifiable condition against real files/git state/npm output, never an
// LLM-guessed "looks fine". Built fresh against this repo's own
// conventions (runSubprocess argv spawning, per-tool static riskLevel,
// describeCall) — NOT a port of any other DevOps CLI's doctor/fix_engine.

const execFileAsync = promisify(execFile);

// Glob patterns for files that typically carry real secrets. ".env.*"
// already subsumes ".env.local" but both are listed for clarity/intent;
// fg dedupes naturally since matches are collected into a Set below.
const SENSITIVE_FILE_GLOBS = ["**/.env", "**/.env.*", "**/*.pem", "**/*.key", "**/id_rsa", "**/id_dsa", "**/id_ecdsa", "**/id_ed25519"];
const IGNORE_GLOBS = ["**/node_modules/**", "**/.git/**"];

interface Finding {
  id: string;
  problem: string;
  why: string;
  fix: string;
}

interface CheckSection {
  name: string;
  idPrefixes: string[];
}

// Canonical list of the 5 checks this tool runs, in report order. A
// finding's `id` is matched against `idPrefixes` to group it under the
// right section when rendering the report.
const CHECK_SECTIONS: CheckSection[] = [
  { name: "Secret-bearing files gitignored", idPrefixes: ["gitignore-missing-entry:"] },
  { name: "Lockfile presence matches package manager", idPrefixes: ["lockfile-missing", "lockfile-conflict"] },
  { name: "Sensitive file permissions", idPrefixes: ["file-permissions:"] },
  { name: "Dependency vulnerabilities (npm audit)", idPrefixes: ["npm-audit-vulnerabilities", "npm-audit-failed", "npm-audit-unavailable"] },
  { name: ".gitignore exists", idPrefixes: ["gitignore-file-missing"] },
];

// Manual-fix guidance for every finding id/prefix that has NO safe
// automated fix (see doctor_fix_project below) — reused both by the
// report's "fix" line and by doctor_fix_project's refusal message so the
// two never drift apart.
const NO_AUTOFIX_EXPLANATIONS: Record<string, string> = {
  "lockfile-missing": "run `npm install` (or `yarn install`/`pnpm install`) once and commit the generated lockfile, this tool won't choose a package manager or install packages for you",
  "lockfile-conflict": "pick one package manager and delete the other lockfile(s) yourself, this tool won't guess which one is authoritative",
  "npm-audit-vulnerabilities": "review the `npm audit` output and update the affected packages yourself (e.g. `npm audit fix`), changing dependency versions can alter behavior or break things, so this tool won't do it automatically",
  "npm-audit-failed": "run `npm audit` manually and investigate why it failed (missing lockfile, offline, registry auth, ...)",
  "npm-audit-unavailable": "install Node.js/npm, then run `npm audit` manually",
  "gitignore-file-missing": "create a .gitignore file yourself with entries appropriate for this project, this tool only auto-fixes a *missing entry* in an existing/new .gitignore for a specific secret file it already found (a gitignore-missing-entry:<file> finding), not authoring a whole .gitignore from scratch",
};

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function findSensitiveFiles(directory: string): Promise<string[]> {
  const matches = await fg(SENSITIVE_FILE_GLOBS, { cwd: directory, dot: true, ignore: IGNORE_GLOBS, onlyFiles: true });
  return [...new Set(matches)].sort();
}

/**
 * Runs a git subcommand via the real, safe argv spawn (runSubprocess) and
 * recovers its real exit code from the formatted result — needed because
 * some git subcommands (check-ignore: 0=ignored/1=not-ignored,
 * rev-parse --is-inside-work-tree: 0=yes/128=no) use the exit code itself
 * as meaningful data, not merely success/failure, so `isError` is
 * disabled and the caller reads the code directly instead.
 */
async function gitExitCode(directory: string, args: string[], ctx: ToolContext, gitBinary: string): Promise<number | null> {
  const result = await runSubprocess(gitBinary, {
    cwd: directory,
    sessionId: ctx.sessionId,
    timeoutMs: 10_000,
    signal: ctx.signal,
    args,
    format: "compact",
    isError: () => false,
  });
  const match = /\(exit code (-?\d+)\)/.exec(result.content);
  return match ? Number(match[1]) : null;
}

async function runChecks(
  directory: string,
  ctx: ToolContext,
  binaries: { gitBinary: string; npmBinary: string },
): Promise<{ findings: Finding[]; skipped: { check: string; reason: string }[] }> {
  const findings: Finding[] = [];
  const skipped: { check: string; reason: string }[] = [];

  const gitAvailable = isCommandAvailable(binaries.gitBinary);
  const isGitRepo = gitAvailable && (await gitExitCode(directory, ["rev-parse", "--is-inside-work-tree"], ctx, binaries.gitBinary)) === 0;

  const sensitiveFiles = await findSensitiveFiles(directory);

  // Check 1: secret-bearing files must actually be gitignored.
  if (!isGitRepo) {
    skipped.push({ check: "Secret-bearing files gitignored", reason: gitAvailable ? "not a git repository" : "git is not available" });
  } else {
    for (const file of sensitiveFiles) {
      const exitCode = await gitExitCode(directory, ["check-ignore", "-q", file], ctx, binaries.gitBinary);
      if (exitCode !== 0) {
        findings.push({
          id: `gitignore-missing-entry:${file}`,
          problem: `${file} exists but is not covered by any .gitignore rule`,
          why: "an unignored secret-bearing file can get committed and pushed, permanently exposing its contents in git history",
          fix: `add "${file}" to .gitignore`,
        });
      }
    }
  }

  // Check 5: .gitignore should exist at all in a git repo.
  if (!isGitRepo) {
    skipped.push({ check: ".gitignore exists", reason: gitAvailable ? "not a git repository" : "git is not available" });
  } else if (!(await pathExists(path.join(directory, ".gitignore")))) {
    findings.push({
      id: "gitignore-file-missing",
      problem: "this git repo has no .gitignore file at all",
      why: "without one, build artifacts, local config, and secret files are all one `git add .` away from being committed",
      fix: "create a .gitignore file with entries for build output, dependency directories, and any local secret files",
    });
  }

  // Check 3: sensitive files should not be group/other readable or writable.
  for (const file of sensitiveFiles) {
    try {
      const info = await stat(path.join(directory, file));
      if (info.mode & 0o066) {
        findings.push({
          id: `file-permissions:${file}`,
          problem: `${file} is readable or writable by group/other (mode ${(info.mode & 0o777).toString(8)})`,
          why: "a secret-bearing file readable by other local users/processes can leak credentials on a shared machine",
          fix: `chmod 600 ${file}`,
        });
      }
    } catch {
      // Deleted between the glob and the stat — not a real finding.
    }
  }

  const hasPackageJson = await pathExists(path.join(directory, "package.json"));

  // Check 2: lockfile presence should match exactly one package manager.
  if (!hasPackageJson) {
    skipped.push({ check: "Lockfile presence matches package manager", reason: "no package.json" });
  } else {
    const lockfiles = ["package-lock.json", "yarn.lock", "pnpm-lock.yaml"];
    const present: string[] = [];
    for (const lockfile of lockfiles) {
      if (await pathExists(path.join(directory, lockfile))) present.push(lockfile);
    }
    if (present.length === 0) {
      findings.push({
        id: "lockfile-missing",
        problem: "package.json exists but no lockfile (package-lock.json/yarn.lock/pnpm-lock.yaml) was found",
        why: "without a lockfile, installs aren't reproducible, the same package.json can resolve to different dependency versions on different machines/CI runs",
        fix: "run `npm install` (or yarn/pnpm install) once and commit the generated lockfile",
      });
    } else if (present.length > 1) {
      findings.push({
        id: "lockfile-conflict",
        problem: `multiple lockfiles present: ${present.join(", ")}`,
        why: "conflicting lockfiles from different package managers can silently diverge, and different machines/CI may pick different ones",
        fix: `pick one package manager and delete the others' lockfiles (keep only one of: ${present.join(", ")})`,
      });
    }
  }

  // Check 4: real npm audit, parsed for real vulnerability counts.
  if (!hasPackageJson) {
    skipped.push({ check: "Dependency vulnerabilities (npm audit)", reason: "no package.json" });
  } else if (!isCommandAvailable(binaries.npmBinary)) {
    findings.push({
      id: "npm-audit-unavailable",
      problem: "npm is not on PATH, so dependency vulnerabilities could not be checked",
      why: "unpatched vulnerable dependencies are a real, exploitable attack surface",
      fix: "install Node.js/npm, then run `npm audit`",
    });
  } else {
    const reportAuditFailure = (detail?: string) =>
      findings.push({
        id: "npm-audit-failed",
        problem: `npm audit failed to run${detail ? `: ${detail}` : ""}`,
        why: "dependency vulnerabilities could not be checked, this doesn't mean there are none",
        fix: "run `npm audit` manually and investigate why it failed",
      });

    const reportAuditCounts = (jsonText: string) => {
      let parsed: any;
      try {
        parsed = JSON.parse(jsonText);
      } catch (err) {
        reportAuditFailure(`could not parse npm audit's JSON output (${err instanceof Error ? err.message : String(err)})`);
        return;
      }
      const counts = parsed?.metadata?.vulnerabilities;
      if (!counts || typeof counts !== "object") {
        reportAuditFailure("no vulnerability summary in npm audit's output");
        return;
      }
      const severities = ["critical", "high", "moderate", "low", "info"];
      const total = typeof counts.total === "number" ? counts.total : severities.reduce((sum, s) => sum + (counts[s] ?? 0), 0);
      if (total > 0) {
        const bySeverity = severities
          .filter((s) => counts[s])
          .map((s) => `${counts[s]} ${s}`)
          .join(", ");
        findings.push({
          id: "npm-audit-vulnerabilities",
          problem: `npm audit found ${total} vulnerable dependenc${total === 1 ? "y" : "ies"} (${bySeverity})`,
          why: "vulnerable dependencies are a real, exploitable attack surface, some allow remote code execution",
          fix: "review `npm audit` output and update/patch the affected packages (`npm audit fix` for non-breaking fixes; check breaking ones manually)",
        });
      }
    };

    try {
      // Bypasses runSubprocess here on purpose: its output goes through
      // truncateOrSpill and a decorated "(exit code N)\n--- stdout ---"
      // header, both of which would corrupt real JSON.parse on large
      // audit output. This still spawns with an argv array (no shell) —
      // the same command-injection-safety property runSubprocess enforces
      // — just without the formatting layer that isn't needed here.
      const { stdout } = await execFileAsync(binaries.npmBinary, ["audit", "--json"], {
        cwd: directory,
        timeout: 60_000,
        maxBuffer: 10 * 1024 * 1024,
      });
      reportAuditCounts(stdout);
    } catch (err: any) {
      // npm audit exits non-zero when it finds vulnerabilities (expected,
      // not a real failure) — execFile still gives us stdout on the
      // rejected promise in that case.
      const stdout = typeof err?.stdout === "string" ? err.stdout : "";
      if (stdout.trim().length > 0) {
        reportAuditCounts(stdout);
      } else {
        reportAuditFailure(err instanceof Error ? err.message : String(err));
      }
    }
  }

  return { findings, skipped };
}

function formatReport(directory: string, findings: Finding[], skipped: { check: string; reason: string }[]): string {
  const lines = [`Doctor report for ${directory}`, ""];
  for (const section of CHECK_SECTIONS) {
    const skip = skipped.find((s) => s.check === section.name);
    const related = findings.filter((f) => section.idPrefixes.some((prefix) => f.id.startsWith(prefix)));
    if (skip) {
      lines.push(`[SKIPPED] ${section.name}, ${skip.reason}`);
    } else if (related.length === 0) {
      lines.push(`[PASS] ${section.name}`);
    } else {
      lines.push(`[FAIL] ${section.name}, ${related.length} issue${related.length === 1 ? "" : "s"}`);
      for (const finding of related) {
        lines.push(`  - ${finding.problem}`);
        lines.push(`    why: ${finding.why}`);
        lines.push(`    fix: ${finding.fix}`);
        lines.push(`    id: ${finding.id}`);
      }
    }
  }
  return lines.join("\n");
}

interface DoctorCheckInput {
  directory?: string;
}

interface DoctorFixInput {
  directory?: string;
  findingIds: string[];
}

export interface DoctorToolOptions {
  gitBinary?: string;
  npmBinary?: string;
}

export function createDoctorTools(options: DoctorToolOptions = {}): ToolDefinition[] {
  const gitBinary = options.gitBinary ?? "git";
  const npmBinary = options.npmBinary ?? "npm";

  const checkProject: ToolDefinition<DoctorCheckInput> = {
    name: "doctor_check_project",
    description:
      "Run a fixed set of REAL, rule-based project-health checks against a project directory (not AI-guessed " +
      "heuristics) and return a structured pass/fail report: (1) secret-bearing files (.env*, *.pem, *.key, " +
      "id_rsa-style) actually gitignored via a real `git check-ignore`, (2) exactly one lockfile matching " +
      "package.json's package manager, (3) real file-permission bits on those same secret-bearing files " +
      "(flags group/other read or write), (4) real `npm audit --json` vulnerability counts by severity, (5) " +
      "whether a .gitignore exists at all. Each failing check reports what's wrong, why it matters, and the " +
      "exact fix, plus a stable finding id usable with doctor_fix_project. A check whose precondition doesn't " +
      "apply (e.g. no package.json) is reported as SKIPPED, not an error.",
    riskLevel: "safe",
    inputSchema: {
      type: "object",
      properties: {
        directory: { type: "string", description: "Directory to check (defaults to the project root)" },
      },
    },
    describeCall: (input) => `doctor_check_project (in ${input.directory ?? "."})`,
    async handler(input, ctx) {
      const directory = input.directory ? resolveAllowedPath(ctx.cwd, input.directory) : ctx.cwd;
      const { findings, skipped } = await runChecks(directory, ctx, { gitBinary, npmBinary });
      return {
        content: formatReport(directory, findings, skipped),
        isError: false,
        metadata: { findingIds: findings.map((f) => f.id), skippedChecks: skipped.map((s) => s.check) },
      };
    },
  };

  const fixProject: ToolDefinition<DoctorFixInput> = {
    name: "doctor_fix_project",
    description:
      "Apply fixes for a list of finding ids returned by a prior doctor_check_project call. Only two finding " +
      "types have a well-defined, genuinely-safe automated fix: `gitignore-missing-entry:<file>` (appends that " +
      "exact line to .gitignore, creating it if missing) and `file-permissions:<file>` (chmod 600). Every other " +
      "finding id (missing/conflicting lockfiles, npm audit results) is refused with a clear explanation of what " +
      "to do manually, running `npm audit fix` or choosing a package manager for someone is a real, " +
      "consequential decision this tool won't make silently. Reports per-finding what was actually changed, " +
      "never a blanket \"done\".",
    riskLevel: "ask",
    inputSchema: {
      type: "object",
      properties: {
        directory: { type: "string", description: "Directory the findings came from (defaults to the project root)" },
        findingIds: { type: "array", items: { type: "string" }, description: "Finding ids from a prior doctor_check_project report" },
      },
      required: ["findingIds"],
    },
    describeCall: (input) => `doctor_fix_project(${input.findingIds.join(", ")}) (in ${input.directory ?? "."})`,
    async handler(input, ctx) {
      const directory = input.directory ? resolveAllowedPath(ctx.cwd, input.directory) : ctx.cwd;
      const results: string[] = [];

      for (const id of input.findingIds) {
        if (id.startsWith("gitignore-missing-entry:")) {
          const file = id.slice("gitignore-missing-entry:".length);
          try {
            const gitignorePath = path.join(directory, ".gitignore");
            const existing = await readFile(gitignorePath, "utf-8").catch(() => "");
            if (existing.split("\n").some((line) => line.trim() === file)) {
              results.push(`${id}: skipped, "${file}" is already in .gitignore`);
              continue;
            }
            const needsNewline = existing.length > 0 && !existing.endsWith("\n");
            await writeFile(gitignorePath, `${existing}${needsNewline ? "\n" : ""}${file}\n`, "utf-8");
            results.push(`${id}: added "${file}" to .gitignore`);
          } catch (err) {
            results.push(`${id}: failed, ${err instanceof Error ? err.message : String(err)}`);
          }
        } else if (id.startsWith("file-permissions:")) {
          const file = id.slice("file-permissions:".length);
          try {
            await chmod(path.join(directory, file), 0o600);
            results.push(`${id}: chmod'd to 600`);
          } catch (err) {
            results.push(`${id}: failed, ${err instanceof Error ? err.message : String(err)}`);
          }
        } else {
          const explanation = NO_AUTOFIX_EXPLANATIONS[id] ?? "no safe automated fix is known for this finding id, fix it manually";
          results.push(`${id}: not auto-fixed, ${explanation}`);
        }
      }

      return { content: results.join("\n"), isError: false };
    },
  };

  return [checkProject, fixProject];
}
