import { readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { ToolRiskLevel } from "../core/types.js";

export type PermissionDecision = "allow" | "ask" | "deny";

export interface PermissionRule {
  tool: string; // tool name, or "*"
  keyPrefix?: string; // matched as a prefix against the tool's riskKey
  decision: PermissionDecision;
}

export interface PermissionConfig {
  defaultForRiskLevel: Record<ToolRiskLevel, PermissionDecision>;
  rules: PermissionRule[];
}

export const DEFAULT_PERMISSION_CONFIG: PermissionConfig = {
  defaultForRiskLevel: {
    safe: "allow",
    ask: "ask",
    dangerous: "ask",
  },
  rules: [],
};

async function readJsonIfExists(file: string): Promise<Partial<PermissionConfig> | undefined> {
  try {
    const raw = await readFile(file, "utf-8");
    return JSON.parse(raw) as Partial<PermissionConfig>;
  } catch (err) {
    // A missing file is normal and silent. Anything else (malformed JSON, a
    // permission error) used to look identical and fall back to defaults
    // with no diagnostic — a typo'd settings.json silently drops the user's
    // own allow-rules, and under --non-interactive an "ask" resolves to a
    // deny worded exactly like a real refusal.
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      console.error(`Warning: failed to read ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return undefined;
  }
}

export async function loadPermissionConfig(cwd: string): Promise<PermissionConfig> {
  const globalFile = path.join(os.homedir(), ".finanfa-code", "config.json");
  const projectFile = path.join(cwd, ".finanfa-code", "settings.json");

  const [globalCfg, projectCfg] = await Promise.all([
    readJsonIfExists(globalFile),
    readJsonIfExists(projectFile),
  ]);

  return {
    defaultForRiskLevel: {
      ...DEFAULT_PERMISSION_CONFIG.defaultForRiskLevel,
      ...globalCfg?.defaultForRiskLevel,
      ...projectCfg?.defaultForRiskLevel,
    },
    rules: [...(globalCfg?.rules ?? []), ...(projectCfg?.rules ?? [])],
  };
}
