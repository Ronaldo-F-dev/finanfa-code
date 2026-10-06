import { readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { ToolRiskLevel } from "../core/types.js";
import type { AutoApprovalClassifierConfig } from "./classifier.js";
import { parseAutoApprove, type AutoApproveSettings } from "./categories.js";

export type PermissionDecision = "allow" | "ask" | "deny";

export interface PermissionRule {
  tool: string; // tool name, or "*"
  keyPrefix?: string; // matched as a prefix against the tool's riskKey
  /**
   * Matched as a prefix against the tool call's actual working directory
   * (ctx.cwd — the resolved directory the call runs in, e.g. bash's own
   * cwd, not the project root a relative `cwd` input is joined onto).
   * Lets a rule apply only within part of a monorepo — e.g. auto-allow
   * `bash` inside `scripts/` (a checked-in, reviewed directory) while
   * still asking everywhere else — instead of a rule's only granularity
   * being the tool name and its own riskKey.
   */
  cwdPrefix?: string;
  decision: PermissionDecision;
}

export interface PermissionConfig {
  defaultForRiskLevel: Record<ToolRiskLevel, PermissionDecision>;
  rules: PermissionRule[];
  /**
   * Opt-in "auto" approval mode (see classifier.ts) — undefined/disabled
   * leaves every existing static risk-level/rules behavior completely
   * unaffected. When enabled, a call that the static logic would otherwise
   * send to "ask" is scored per-call by a real classifier LLM call first.
   */
  autoApprovalClassifier?: AutoApprovalClassifierConfig;
  /**
   * Categories of tool calls approved without asking (see categories.ts). Read ONLY from the user's own global
   * config, never from a project's settings.json: this removes prompts, and a repository must not be able to
   * switch that on for whoever opens it. An explicit rule for a tool still wins over it.
   */
  autoApprove?: AutoApproveSettings;
}

export const DEFAULT_PERMISSION_CONFIG: PermissionConfig = {
  defaultForRiskLevel: {
    safe: "allow",
    ask: "ask",
    dangerous: "ask",
  },
  rules: [],
};

/** Leaves the field unset when nothing is configured, so a config with no approvals looks exactly as it did before the field existed. */
function nonEmpty(settings: AutoApproveSettings): AutoApproveSettings | undefined {
  return Object.keys(settings).length > 0 ? settings : undefined;
}

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

/**
 * `trusted` gates whether the PROJECT-level settings.json is read at all —
 * see core/trust.ts. An untrusted project's rules (e.g. a blanket
 * `{tool: "*", decision: "allow"}`) must never take effect just because
 * the user happened to `cd` into a cloned repo; only the user's own
 * global ~/.finanfa-code/config.json applies until they explicitly trust
 * the folder. Defaults to true so every existing caller (and every
 * existing test) keeps its prior behavior unless it opts into the gate.
 */
export async function loadPermissionConfig(cwd: string, trusted = true): Promise<PermissionConfig> {
  const globalFile = path.join(os.homedir(), ".finanfa-code", "config.json");
  const projectFile = path.join(cwd, ".finanfa-code", "settings.json");

  const [globalCfg, projectCfg] = await Promise.all([
    readJsonIfExists(globalFile),
    trusted ? readJsonIfExists(projectFile) : Promise.resolve(undefined),
  ]);

  return {
    defaultForRiskLevel: {
      ...DEFAULT_PERMISSION_CONFIG.defaultForRiskLevel,
      ...globalCfg?.defaultForRiskLevel,
      ...projectCfg?.defaultForRiskLevel,
    },
    rules: [...(globalCfg?.rules ?? []), ...(projectCfg?.rules ?? [])],
    // Project-level setting wins over global, same precedence as defaultForRiskLevel above.
    autoApprovalClassifier: projectCfg?.autoApprovalClassifier ?? globalCfg?.autoApprovalClassifier,
    autoApprove: nonEmpty(parseAutoApprove(globalCfg?.autoApprove)),
  };
}
