import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import fg from "fast-glob";
import type { ToolDefinition } from "../../core/types.js";

interface GrepInput {
  pattern: string;
  path?: string;
  glob?: string;
  caseInsensitive?: boolean;
}

function runRipgrep(input: GrepInput, cwd: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const args = ["--line-number", "--color=never"];
    if (input.caseInsensitive) args.push("--ignore-case");
    if (input.glob) args.push("--glob", input.glob);
    args.push(input.pattern, input.path ?? ".");

    const child = spawn("rg", args, { cwd });
    let out = "";
    child.stdout?.on("data", (d) => (out += d));
    child.on("error", () => resolve(undefined)); // rg not installed → fall back
    child.on("close", (code) => {
      if (code === 0 || code === 1) resolve(out); // 1 = no matches, still valid
      else resolve(undefined);
    });
  });
}

async function fallbackGrep(input: GrepInput, cwd: string): Promise<string> {
  const files = await fg(input.glob ?? "**/*", {
    cwd: input.path ? `${cwd}/${input.path}` : cwd,
    ignore: ["**/node_modules/**", "**/.git/**"],
    onlyFiles: true,
    dot: false,
  });
  const regex = new RegExp(input.pattern, input.caseInsensitive ? "i" : "");
  const lines: string[] = [];
  for (const file of files) {
    const full = input.path ? `${cwd}/${input.path}/${file}` : `${cwd}/${file}`;
    let content: string;
    try {
      content = await readFile(full, "utf-8");
    } catch {
      continue;
    }
    content.split("\n").forEach((line, i) => {
      if (regex.test(line)) lines.push(`${file}:${i + 1}:${line}`);
    });
  }
  return lines.join("\n");
}

export const grepTool: ToolDefinition<GrepInput> = {
  name: "grep",
  description: "Search file contents for a regex pattern, optionally scoped by path or glob.",
  riskLevel: "safe",
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regex pattern to search for" },
      path: { type: "string", description: "Subdirectory to search within" },
      glob: { type: "string", description: "Restrict search to files matching this glob" },
      caseInsensitive: { type: "boolean" },
    },
    required: ["pattern"],
  },
  describeCall: (input) => `grep "${input.pattern}"${input.path ? ` in ${input.path}` : ""}`,
  async handler(input, ctx) {
    const rgResult = await runRipgrep(input, ctx.cwd);
    const output = rgResult ?? (await fallbackGrep(input, ctx.cwd));
    return {
      content: output.trim().length > 0 ? output : "(no matches)",
      isError: false,
    };
  },
};
