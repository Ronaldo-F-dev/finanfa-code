import fg from "fast-glob";
import type { ToolDefinition } from "../../core/types.js";

interface GlobInput {
  pattern: string;
  path?: string;
}

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
    return {
      content: matches.length > 0 ? matches.join("\n") : "(no matches)",
      isError: false,
      metadata: { count: matches.length },
    };
  },
};
