import { describe, expect, it, vi, beforeEach } from "vitest";

// diff-view.ts is the one module in this package whose whole job is
// talking to the real `vscode` module (Uri/EventEmitter/commands/
// workspace) — there's no real VS Code process in a vitest run, so this
// fakes just enough of the API surface it actually calls, matching how
// bundle.test.ts's own real-require smoke test stubs `vscode` for the
// extension host, one level up (a real child process there; a real vi.mock
// here, since this file is exercised directly as source, not the compiled
// bundle).
const executeCommand = vi.fn();
const registerTextDocumentContentProvider = vi.fn();

vi.mock("vscode", () => ({
  Uri: {
    from: (opts: { scheme: string; path: string }) => ({ scheme: opts.scheme, path: opts.path, toString: () => `${opts.scheme}:${opts.path}` }),
  },
  workspace: { registerTextDocumentContentProvider },
  commands: { executeCommand },
}));

describe("registerDiffView", () => {
  beforeEach(() => {
    executeCommand.mockClear();
    registerTextDocumentContentProvider.mockClear();
  });

  it("registers the content provider once, added to context.subscriptions for cleanup", async () => {
    const { registerDiffView } = await import("../../src/webview/diff-view.js");
    const subscriptions: unknown[] = [];
    registerTextDocumentContentProvider.mockReturnValue({ dispose: vi.fn() });

    registerDiffView({ subscriptions } as never);

    expect(registerTextDocumentContentProvider).toHaveBeenCalledWith("finanfa-diff", expect.anything());
    expect(subscriptions).toHaveLength(1);
  });

  it("opens a real vscode.diff with the before/after content served back through the content provider", async () => {
    const { registerDiffView } = await import("../../src/webview/diff-view.js");
    let provider!: { provideTextDocumentContent: (uri: { toString(): string }) => string };
    registerTextDocumentContentProvider.mockImplementation((_scheme: string, p: typeof provider) => {
      provider = p;
      return { dispose: vi.fn() };
    });

    const openFileDiff = registerDiffView({ subscriptions: [] } as never);
    openFileDiff({ path: "src/a.ts", before: "old content", after: "new content" });

    expect(executeCommand).toHaveBeenCalledTimes(1);
    const [command, beforeUri, afterUri, title, opts] = executeCommand.mock.calls[0];
    expect(command).toBe("vscode.diff");
    expect(title).toBe("src/a.ts (proposed change)");
    expect(opts).toEqual({ preview: true });
    expect(provider.provideTextDocumentContent(beforeUri)).toBe("old content");
    expect(provider.provideTextDocumentContent(afterUri)).toBe("new content");
  });

  it("gives each call its own fresh pair of URIs, never reusing (and never leaking into) a prior call's content", async () => {
    const { registerDiffView } = await import("../../src/webview/diff-view.js");
    let provider!: { provideTextDocumentContent: (uri: { toString(): string }) => string };
    registerTextDocumentContentProvider.mockImplementation((_scheme: string, p: typeof provider) => {
      provider = p;
      return { dispose: vi.fn() };
    });

    const openFileDiff = registerDiffView({ subscriptions: [] } as never);
    openFileDiff({ path: "a.ts", before: "first before", after: "first after" });
    const [, firstBeforeUri, firstAfterUri] = executeCommand.mock.calls[0];

    openFileDiff({ path: "a.ts", before: "second before", after: "second after" });
    const [, secondBeforeUri, secondAfterUri] = executeCommand.mock.calls[1];

    expect(firstBeforeUri.toString()).not.toBe(secondBeforeUri.toString());
    expect(provider.provideTextDocumentContent(firstBeforeUri)).toBe("first before");
    expect(provider.provideTextDocumentContent(firstAfterUri)).toBe("first after");
    expect(provider.provideTextDocumentContent(secondBeforeUri)).toBe("second before");
    expect(provider.provideTextDocumentContent(secondAfterUri)).toBe("second after");
  });

  it("uses just the filename (not the full path) for the virtual document's own path segment, for correct syntax highlighting", async () => {
    const { registerDiffView } = await import("../../src/webview/diff-view.js");
    registerTextDocumentContentProvider.mockReturnValue({ dispose: vi.fn() });
    const openFileDiff = registerDiffView({ subscriptions: [] } as never);

    openFileDiff({ path: "packages/core/src/index.ts", before: "", after: "x" });

    const [, beforeUri, afterUri] = executeCommand.mock.calls[0];
    expect(beforeUri.path).toMatch(/\/before\/index\.ts$/);
    expect(afterUri.path).toMatch(/\/after\/index\.ts$/);
  });
});
