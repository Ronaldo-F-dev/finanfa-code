import { readFile } from "node:fs/promises";
import path from "node:path";

export interface McpServerConfig {
  name: string;
  transport: "stdio" | "http" | "sse";
  // stdio
  command?: string;
  args?: string[];
  // http / sse (remote servers — OAuth is attempted automatically if the
  // server responds 401; see src/mcp/oauth-provider.ts)
  url?: string;
}

export async function loadMcpServers(cwd: string): Promise<McpServerConfig[]> {
  const file = path.join(cwd, ".finanfa-code", "mcp.json");
  try {
    const raw = await readFile(file, "utf-8");
    const parsed = JSON.parse(raw) as { servers?: McpServerConfig[] };
    return parsed.servers ?? [];
  } catch (err) {
    // A missing file is normal and silent. Anything else (malformed JSON, a
    // permission error) used to look identical and fall back to "no servers"
    // with no diagnostic — a typo'd mcp.json silently drops every configured
    // MCP server with nothing pointing at why.
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      console.error(`Warning: failed to read ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return [];
  }
}
