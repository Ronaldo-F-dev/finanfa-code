// Real, activation-blocking bug found via the real VS Code extension host's
// exthost.log (not reproducible under plain `node`, which is why
// test/bundle.test.ts's require()-only smoke check didn't catch it):
//
//   ReferenceError: DOMMatrix is not defined
//     at Module.<anonymous> (node_modules/pdf-parse/dist/.../index.cjs:...)
//
// pdf-parse's own pdfjs-dist dependency references the browser DOMMatrix API
// at module TOP LEVEL, unconditionally — VS Code's real Electron extension
// host runs as a plain Node.js process (no Chromium/DOM), unlike a webview
// (which does have a real DOM) or a renderer process. Requiring pdf-parse
// eagerly (it's a static import reached through registerBuiltins →
// read_document/convert_pdf_to_image) crashed the WHOLE extension's
// activation, not just those two tools.
//
// A minimal stand-in — just enough to be referenced and constructed without
// throwing — unblocks activation. If a tool actually tries to render/parse
// through pdfjs-dist's DOMMatrix-dependent code path later, THAT specific
// call may still fail (an accepted, documented Phase 1 limitation for
// platform/environment-specific tools — see the plan's §3), but it no
// longer takes the entire extension down with it.
//
// Imported first (before any other module) in extension.ts, so its
// assignment runs before the import chain that eventually requires
// pdf-parse — ES module imports evaluate each imported module's body to
// completion, in written order, before the importing file's own code runs.
class DOMMatrixStub {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(..._args: unknown[]) {}
}

if (typeof (globalThis as { DOMMatrix?: unknown }).DOMMatrix === "undefined") {
  (globalThis as { DOMMatrix?: unknown }).DOMMatrix = DOMMatrixStub;
}
