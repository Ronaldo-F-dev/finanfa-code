import { describe, expect, it, vi, beforeEach } from "vitest";

// selection-commands.ts only touches vscode.commands.registerCommand,
// vscode.window.activeTextEditor and vscode.workspace.asRelativePath — the
// rest of the real vscode.TextEditor/TextDocument surface is stood in for
// by plain duck-typed objects (buildSnippet only reads a handful of fields
// off them), same minimal-mock approach as diff-view.test.ts.
const { registerCommand, asRelativePath } = vi.hoisted(() => ({
  registerCommand: vi.fn(),
  asRelativePath: vi.fn((uri: { fsPath?: string }) => uri.fsPath ?? String(uri)),
}));
let activeTextEditor: unknown;

vi.mock("vscode", () => ({
  commands: { registerCommand },
  window: {
    get activeTextEditor() {
      return activeTextEditor;
    },
  },
  workspace: { asRelativePath },
}));

import { formatSnippetForChat, registerSelectionCommands } from "../../src/commands/selection-commands.js";

describe("formatSnippetForChat", () => {
  it("includes the line range in the header when there is a selection", () => {
    const result = formatSnippetForChat({
      text: "const x = 1;",
      languageId: "typescript",
      relativePath: "src/a.ts",
      startLine: 3,
      endLine: 3,
      hasSelection: true,
    });
    expect(result).toBe("```typescript src/a.ts:3-3\nconst x = 1;\n```");
  });

  it("omits the line range when there's no selection (whole-file fallback)", () => {
    const result = formatSnippetForChat({
      text: "whole file",
      languageId: "python",
      relativePath: "b.py",
      startLine: 1,
      endLine: 10,
      hasSelection: false,
    });
    expect(result).toBe("```python b.py\nwhole file\n```");
  });
});

describe("registerSelectionCommands", () => {
  beforeEach(() => {
    registerCommand.mockClear();
    asRelativePath.mockClear();
    activeTextEditor = undefined;
  });

  function makeEditor(opts: { text: string; hasSelection: boolean; languageId?: string; path?: string }) {
    return {
      document: {
        getText: () => opts.text,
        languageId: opts.languageId ?? "typescript",
        uri: { fsPath: opts.path ?? "src/a.ts" },
      },
      selection: { isEmpty: !opts.hasSelection, start: { line: 4 }, end: { line: 6 } },
    };
  }

  function handlerFor(command: string): () => Promise<void> {
    const call = registerCommand.mock.calls.find((c) => c[0] === command);
    if (!call) throw new Error(`command ${command} was never registered`);
    return call[1] as () => Promise<void>;
  }

  it("registers both the add-to-chat and explain commands", () => {
    registerSelectionCommands({ subscriptions: [] } as never, { sendToChat: vi.fn() } as never);

    expect(registerCommand).toHaveBeenCalledWith("finanfa-code.addSelectionToChat", expect.any(Function));
    expect(registerCommand).toHaveBeenCalledWith("finanfa-code.explainSelection", expect.any(Function));
  });

  it("addSelectionToChat sends the selected snippet, with the 1-based line range and no autoSend", async () => {
    const chatView = { sendToChat: vi.fn() };
    registerSelectionCommands({ subscriptions: [] } as never, chatView as never);
    activeTextEditor = makeEditor({ text: "const y = 2;", hasSelection: true });

    await handlerFor("finanfa-code.addSelectionToChat")();

    expect(chatView.sendToChat).toHaveBeenCalledWith("```typescript src/a.ts:5-7\nconst y = 2;\n```");
  });

  it("explainSelection sends with autoSend: true, prefixed with a French explain prompt, falling back to the whole file with no selection", async () => {
    const chatView = { sendToChat: vi.fn() };
    registerSelectionCommands({ subscriptions: [] } as never, chatView as never);
    activeTextEditor = makeEditor({ text: "def f(): pass", hasSelection: false, languageId: "python", path: "b.py" });

    await handlerFor("finanfa-code.explainSelection")();

    expect(chatView.sendToChat).toHaveBeenCalledWith(expect.stringContaining("```python b.py\ndef f(): pass\n```"), { autoSend: true });
  });

  it("is a no-op when there is no active editor, rather than sending an empty snippet", async () => {
    const chatView = { sendToChat: vi.fn() };
    registerSelectionCommands({ subscriptions: [] } as never, chatView as never);
    activeTextEditor = undefined;

    await handlerFor("finanfa-code.addSelectionToChat")();

    expect(chatView.sendToChat).not.toHaveBeenCalled();
  });
});
