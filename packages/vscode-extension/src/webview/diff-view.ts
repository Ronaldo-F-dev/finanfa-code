import * as vscode from "vscode";
import type { FilePreview } from "@finanfa/core/src/core/types.js";

const SCHEME = "finanfa-diff";

/**
 * Backs a virtual before/after pair of documents for `vscode.diff` — both
 * sides are virtual (never the real on-disk file) so this works identically
 * whether the file already exists or not (a brand-new file's "before" is
 * simply an empty virtual document), and so a stale cached "before" is never
 * shown: each openFileDiff() call gets its own fresh pair of URIs, never
 * reused.
 */
class DiffContentProvider implements vscode.TextDocumentContentProvider {
  private readonly content = new Map<string, string>();

  set(uri: vscode.Uri, text: string): void {
    this.content.set(uri.toString(), text);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.content.get(uri.toString()) ?? "";
  }
}

let nextDiffId = 1;

/**
 * Registers the virtual-document provider once (per extension activation)
 * and returns a function that opens a real, native VS Code diff editor tab
 * for a FilePreview — the richer view a permission prompt for
 * write_file/edit_file/multi_edit_file gets alongside the webview's own
 * PermissionModal (see vscode-ui-adapter.ts's openFileDiff callback).
 */
export function registerDiffView(context: vscode.ExtensionContext): (preview: FilePreview) => void {
  const provider = new DiffContentProvider();
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(SCHEME, provider));

  return (preview: FilePreview) => {
    const id = nextDiffId++;
    // The filename segment (not the full path, which may contain characters
    // Uri.from's path component would otherwise need escaping) drives the
    // tab's syntax highlighting via its extension.
    const filename = preview.path.split(/[/\\]/).pop() || preview.path;
    const beforeUri = vscode.Uri.from({ scheme: SCHEME, path: `/${id}/before/${filename}` });
    const afterUri = vscode.Uri.from({ scheme: SCHEME, path: `/${id}/after/${filename}` });
    provider.set(beforeUri, preview.before);
    provider.set(afterUri, preview.after);
    void vscode.commands.executeCommand("vscode.diff", beforeUri, afterUri, `${preview.path} (proposed change)`, { preview: true });
  };
}
