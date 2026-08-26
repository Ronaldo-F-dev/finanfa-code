import { readFile } from "node:fs/promises";
import path from "node:path";

export interface McpServerConfig {
  name: string;
  transport: "stdio";
  command: string;
  args?: string[];
}

export async function loadMcpServers(cwd: string): Promise<McpServerConfig[]> {
  const file = path.join(cwd, ".finanfa-code", "mcp.json");
  try {
    const raw = await readFile(file, "utf-8");
    const parsed = JSON.parse(raw) as { servers?: McpServerConfig[] };
    return parsed.servers ?? [];
  } catch {
    return [];
  }
}
