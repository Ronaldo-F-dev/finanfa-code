import fg from "fast-glob";
import type { ToolDefinition } from "../../core/types.js";

interface GlobInput {
  pattern: string;
  path?: string;
}

const MAX_MATCHES = 1000;

export const globTool: ToolDefinition<GlobInput> = {
  name: "glob",
  description: "List files matching a glob pattern, relative to the project root (or a given subdirectory).",
  riskLevel: "safe",
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern, e.g. 'src/**/*.ts'" },
      path: { type: "string", description: "Subdirectory to search within, relative to the project root" },
    },
    required: ["pattern"],
  },
  describeCall: (input) => `glob ${input.pattern}${input.path ? ` in ${input.path}` : ""}`,
  async handler(input, ctx) {
    const cwd = input.path ? `${ctx.cwd}/${input.path}` : ctx.cwd;
    const matches = await fg(input.pattern, {
      cwd,
      dot: false,
      ignore: ["**/node_modules/**", "**/.git/**"],
      onlyFiles: true,
    });
    matches.sort();
    const shown = matches.slice(0, MAX_MATCHES);
    let content = shown.length > 0 ? shown.join("\n") : "(no matches)";
    if (matches.length > MAX_MATCHES) {
      content += `\n... (truncated, showing first ${MAX_MATCHES} of ${matches.length} matches)`;
    }
    return {
      content,
      isError: false,
      metadata: { count: matches.length },
    };
  },
};
