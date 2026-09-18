import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadCustomCommands, expandCustomCommand, runCustomCommand, type CustomCommand } from "../../src/commands/custom-commands.js";
import { AgentSession } from "../../src/core/session.js";
import type { LlmProvider, StreamTurnResult } from "../../src/core/types.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { PermissionManager } from "../../src/permissions/manager.js";
import { DEFAULT_PERMISSION_CONFIG } from "../../src/permissions/config.js";
import type { UIAdapter } from "../../src/ui/adapter.js";

describe("commands/custom-commands: loading", () => {
  let dir: string;
  let homeDir: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "finanfa-customcmd-"));
    await mkdir(path.join(dir, ".finanfa-code", "commands"), { recursive: true });
    homeDir = await mkdtemp(path.join(tmpdir(), "finanfa-customcmd-home-"));
    originalHome = process.env.HOME;
    process.env.HOME = homeDir;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(dir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  it("returns an empty map when there is no commands directory", async () => {
    const empty = await mkdtemp(path.join(tmpdir(), "finanfa-customcmd-empty-"));
    expect((await loadCustomCommands(empty)).size).toBe(0);
    await rm(empty, { recursive: true, force: true });
  });

  it("merges global (~/.finanfa-code/commands) and project-local commands", async () => {
    await mkdir(path.join(homeDir, ".finanfa-code", "commands"), { recursive: true });
    await writeFile(
      path.join(homeDir, ".finanfa-code", "commands", "review.md"),
      "---\nname: review\ndescription: A systemwide review shortcut\n---\nReview the current diff.",
    );
    await writeFile(
      path.join(dir, ".finanfa-code", "commands", "deploy.md"),
      "---\nname: deploy\ndescription: Deploy this project\n---\nRun the deploy steps for this project.",
    );

    const commands = await loadCustomCommands(dir);
    expect([...commands.keys()].sort()).toEqual(["deploy", "review"]);
  });

  it("project-local command wins over a global one with the same name", async () => {
    await mkdir(path.join(homeDir, ".finanfa-code", "commands"), { recursive: true });
    await writeFile(
      path.join(homeDir, ".finanfa-code", "commands", "deploy.md"),
      "---\nname: deploy\ndescription: global version\n---\nglobal content",
    );
    await writeFile(
      path.join(dir, ".finanfa-code", "commands", "deploy.md"),
      "---\nname: deploy\ndescription: project version\n---\nproject content",
    );

    const commands = await loadCustomCommands(dir);
    expect(commands.get("deploy")!.description).toBe("project version");
    expect(commands.get("deploy")!.content).toBe("project content");
  });

  it("falls back to the filename (minus .md) when frontmatter has no name", async () => {
    await writeFile(path.join(dir, ".finanfa-code", "commands", "quick-fix.md"), "Just do a quick fix.");
    const commands = await loadCustomCommands(dir);
    expect(commands.has("quick-fix")).toBe(true);
    expect(commands.get("quick-fix")!.content).toBe("Just do a quick fix.");
  });

  it("warns and skips a malformed command file instead of throwing", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await writeFile(path.join(dir, ".finanfa-code", "commands", "bad.md"), "---\nname: [unterminated\n---\ncontent");
      const commands = await loadCustomCommands(dir);
      expect(commands.has("bad")).toBe(false);
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("expandCustomCommand", () => {
  const base: CustomCommand = { name: "x", description: "", content: "template", scope: "project" };

  it("replaces every $ARGUMENTS occurrence with the given args", () => {
    const command = { ...base, content: "Fix issue $ARGUMENTS please, re: $ARGUMENTS" };
    expect(expandCustomCommand(command, "#42")).toBe("Fix issue #42 please, re: #42");
  });

  it("appends the args on their own paragraph when the template has no $ARGUMENTS", () => {
    const command = { ...base, content: "Review the current diff." };
    expect(expandCustomCommand(command, "focus on security")).toBe("Review the current diff.\n\nfocus on security");
  });

  it("returns the template verbatim when there are no args and no $ARGUMENTS", () => {
    const command = { ...base, content: "Review the current diff." };
    expect(expandCustomCommand(command, "")).toBe("Review the current diff.");
  });
});

function makeStubUi(): UIAdapter {
  return {
    writeAssistantDelta: vi.fn(),
    endAssistantMessage: vi.fn(),
    writeBanner: vi.fn(),
    writeSystem: vi.fn(),
    writeError: vi.fn(),
    setStatus: vi.fn(),
    getStatus: vi.fn().mockReturnValue(undefined),
    setCommands: vi.fn(),
    setBusy: vi.fn(),
    askUser: vi.fn().mockResolvedValue(""),
    close: vi.fn(),
  };
}

describe("runCustomCommand", () => {
  it("expands the template and runs it through the real agent loop", async () => {
    let capturedUserContent: string | undefined;
    class CapturingProvider implements LlmProvider {
      async streamTurn(params: { messages: { role: string; content?: string }[] }): Promise<StreamTurnResult> {
        const last = params.messages[params.messages.length - 1];
        capturedUserContent ??= last && "content" in last ? last.content : undefined;
        return { assistantMessage: { role: "assistant", content: "done" }, usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end_turn" };
      }
    }

    const ui = makeStubUi();
    const permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true });
    const session = new AgentSession({ cwd: "/tmp", model: "test-model", systemPrompt: "sys" });
    const command: CustomCommand = { name: "review", description: "", content: "Review the diff, focus: $ARGUMENTS", scope: "project" };

    const outcome = await runCustomCommand(
      {
        session,
        ui,
        tools: new ToolRegistry(),
        permissions,
        mcp: undefined as never,
        provider: new CapturingProvider(),
        cwd: "/tmp",
        args: "security",
        setSession: () => {},
      },
      command,
    );

    expect(outcome).toBe("continue");
    expect(capturedUserContent).toBe("Review the diff, focus: security");
  });

  it(
    "real, reported bug: does not block on title generation — a second, invisible provider call with " +
      "no busy indicator that used to hold up the whole command (and the CLI repl's next prompt) for " +
      "however long it took against a slow model, even if it never resolved at all",
    async () => {
      let calls = 0;
      class FirstCallOkThenHangsProvider implements LlmProvider {
        async streamTurn(): Promise<StreamTurnResult> {
          calls++;
          if (calls === 1) {
            return { assistantMessage: { role: "assistant", content: "done" }, usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end_turn" };
          }
          // The title-generation call — never resolves, simulating a
          // genuinely stuck local model. If runCustomCommand awaited this,
          // the test itself would hang forever.
          return new Promise<StreamTurnResult>(() => {});
        }
      }

      const ui = makeStubUi();
      const permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true });
      const session = new AgentSession({ cwd: "/tmp", model: "test-model", systemPrompt: "sys" });
      const command: CustomCommand = { name: "review", description: "", content: "Review the diff", scope: "project" };

      const outcome = await runCustomCommand(
        {
          session,
          ui,
          tools: new ToolRegistry(),
          permissions,
          mcp: undefined as never,
          provider: new FirstCallOkThenHangsProvider(),
          cwd: "/tmp",
          args: "",
          setSession: () => {},
        },
        command,
      );

      expect(outcome).toBe("continue");
      expect(calls).toBeGreaterThanOrEqual(1);
    },
  );
});
