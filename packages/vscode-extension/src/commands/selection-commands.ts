import * as vscode from "vscode";
import type { ChatViewProvider } from "../webview/chat-view-provider.js";

/**
 * Pure formatting, kept separate from the vscode.TextEditor it's normally
 * built from so it's directly unit-testable — mocking a real TextEditor's
 * document/selection API is far more brittle than passing plain values.
 */
export function formatSnippetForChat(opts: {
  text: string;
  languageId: string;
  relativePath: string;
  startLine: number;
  endLine: number;
  hasSelection: boolean;
}): string {
  const header = opts.hasSelection ? `${opts.relativePath}:${opts.startLine}-${opts.endLine}` : opts.relativePath;
  return `\`\`\`${opts.languageId} ${header}\n${opts.text}\n\`\`\``;
}

function buildSnippet(editor: vscode.TextEditor): string {
  const doc = editor.document;
  const selection = editor.selection;
  const hasSelection = !selection.isEmpty;
  return formatSnippetForChat({
    text: hasSelection ? doc.getText(selection) : doc.getText(),
    languageId: doc.languageId,
    relativePath: vscode.workspace.asRelativePath(doc.uri),
    startLine: selection.start.line + 1,
    endLine: selection.end.line + 1,
    hasSelection,
  });
}

/**
 * "Add Selection to Chat" / "Explain Selection" — the one everyday-workflow
 * piece every comparable extension (Copilot Chat, Cursor, Continue) has and
 * this one, until now, entirely lacked: no command, no editor-context-menu
 * entry, no way to reach the agent except manually opening the sidebar and
 * typing (or pasting) code by hand. Falls back to the whole active file
 * when there's no selection, rather than doing nothing.
 */
export function registerSelectionCommands(context: vscode.ExtensionContext, chatView: ChatViewProvider): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("finanfa-code.addSelectionToChat", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      await chatView.sendToChat(buildSnippet(editor));
    }),
    vscode.commands.registerCommand("finanfa-code.explainSelection", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      await chatView.sendToChat(`Explique ce code :\n\n${buildSnippet(editor)}`, { autoSend: true });
    }),
  );
}
