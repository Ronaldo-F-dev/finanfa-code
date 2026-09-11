import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Built separately from the extension host (esbuild bundles src/extension.ts
// for Node; this bundles the webview's browser-side React app) — see the
// plan's §0/§3 for why the two toolchains must never mix. Output lands at
// packages/vscode-extension/dist/webview/, which chat-view-provider.ts
// serves via webview.asWebviewUri.
export default defineConfig({
  plugins: [react()],
  // Relative asset paths are required: a webview is served from a
  // vscode-webview:// origin that asWebviewUri rewrites per-resource, not a
  // normal HTTP root — absolute "/assets/..." paths silently fail to
  // resolve there (a well-known VS Code webview + Vite gotcha).
  base: "./",
  build: {
    outDir: "../dist/webview",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // A webview loads once per panel open, not incrementally like a
        // normal page load — a single bundle is simpler to reference from
        // the CSP-nonce'd <script> tag than chunked output.
        manualChunks: undefined,
        entryFileNames: "index.js",
        assetFileNames: (info) => (info.name?.endsWith(".css") ? "index.css" : "assets/[name][extname]"),
      },
    },
  },
});
