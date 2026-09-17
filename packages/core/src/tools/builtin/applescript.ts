import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ToolDefinition } from "../../core/types.js";
import { runSubprocess } from "../../util/process.js";

// macOS UI automation — a real gap relative to a comparable project's
// native macOS app, which can drive other applications directly. The
// standard, real mechanism for this on macOS is AppleScript via
// `osascript`: not just a scripting curiosity but the actual API surface
// most macOS apps (Finder, Mail, System Events for cross-app UI
// scripting/accessibility control, Music, and any AppleScript-dictionary-
// exposing app) expose for external control — the same mechanism a real
// human-written automation script or Automator workflow would use.
//
// Written to a real temp file rather than passed as `osascript -e
// <script>`: runSubprocess spawns through a real shell when given args
// (see process.ts), which retokenizes a joined command+args string — the
// exact bug debug-python.ts/debug-node.ts hit and fixed the same way for
// a multi-line script containing quotes/newlines.
const DEFAULT_TIMEOUT_MS = 30_000;

interface RunAppleScriptInput {
  script: string;
  timeout_ms?: number;
}

export function createRunAppleScriptTool(): ToolDefinition<RunAppleScriptInput> {
  return {
    name: "run_applescript",
    description:
      "Run a real AppleScript via osascript (macOS only) — drives other applications directly: Finder, Mail, " +
      "Music, System Events (cross-app UI scripting: clicking a button, reading a window's contents, sending " +
      "keystrokes to whatever app is frontmost), or any app exposing an AppleScript dictionary. " +
      "IMPORTANT: this controls real running applications on the user's machine — confirm what it will do " +
      "before calling this unless the user has explicitly asked for this exact action.",
    riskLevel: "dangerous",
    inputSchema: {
      type: "object",
      properties: {
        script: { type: "string", description: "Real AppleScript source, e.g. 'tell application \"Finder\" to get name of every disk'" },
        timeout_ms: { type: "number", description: "Timeout in milliseconds (default 30000)" },
      },
      required: ["script"],
    },
    describeCall: (input) => `run AppleScript: ${input.script.split("\n")[0]!.slice(0, 60)}`,
    async handler(input, ctx) {
      const tmpDir = await mkdtemp(path.join(tmpdir(), "finanfa-applescript-"));
      try {
        const scriptPath = path.join(tmpDir, "script.applescript");
        await writeFile(scriptPath, input.script, "utf-8");
        return await runSubprocess("osascript", {
          cwd: ctx.cwd,
          sessionId: ctx.sessionId,
          timeoutMs: input.timeout_ms ?? DEFAULT_TIMEOUT_MS,
          signal: ctx.signal,
          args: [scriptPath],
          format: "compact",
        });
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    },
  };
}
