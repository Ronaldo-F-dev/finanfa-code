import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createTwoFilesPatch } from "diff";
import type { ToolDefinition } from "../../core/types.js";
import { resolveAllowedPath } from "./path-guard.js";
import { openUrl } from "../../util/open-url.js";
import type { PreviewServer } from "../../core/preview-server.js";

interface CreateArtifactInput {
  path: string;
  code: string;
  title?: string;
}

const REACT_VERSION = "18.3.1";
const BABEL_STANDALONE_VERSION = "7.25.6";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderArtifactHtml(code: string, title: string): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)}</title>
<script src="https://unpkg.com/react@${REACT_VERSION}/umd/react.development.js" crossorigin></script>
<script src="https://unpkg.com/react-dom@${REACT_VERSION}/umd/react-dom.development.js" crossorigin></script>
<script src="https://unpkg.com/@babel/standalone@${BABEL_STANDALONE_VERSION}/babel.min.js" crossorigin></script>
<script src="https://cdn.tailwindcss.com"></script>
<style>
  html,body,#root{height:100%;margin:0}
  *{box-sizing:border-box}
  body{-webkit-font-smoothing:antialiased;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
</style>
</head>
<body>
<div id="root"></div>
<script type="text/babel" data-presets="react" data-type="module">
${code}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
</script>
<!-- Polls its own URL and reloads on change, so an artifact edited afterwards
     with edit_file (which never re-opens a tab) shows up in an already-open
     one instead of going stale. Gives up after ~30 min so a forgotten tab
     doesn't poll forever. -->
<script>
(function () {
  var baseline = null;
  var ticks = 0;
  function poll() {
    fetch(location.href, { cache: "no-store" })
      .then(function (r) { return r.text(); })
      .then(function (html) {
        if (baseline === null) { baseline = html; return; }
        if (html !== baseline) location.reload();
      })
      .catch(function () {});
  }
  poll(); // establish the baseline immediately — waiting for the first
          // interval tick left a ~1s window where an edit landing before
          // that tick got silently adopted as the baseline instead of
          // detected as a change.
  var timer = setInterval(function () {
    if (++ticks > 1800) { clearInterval(timer); return; }
    poll();
  }, 1000);
})();
</script>
</body>
</html>
`;
}

export function createArtifactTool(server: PreviewServer): ToolDefinition<CreateArtifactInput> {
  return {
    name: "create_artifact",
    description:
      "Create a live, running React component (an \"artifact\") from a single piece of JSX and open it in the " +
      "browser. `code` must define a component named `App` (e.g. `function App() { ... }`) — no imports, no " +
      "build step: React, ReactDOM, JSX (via in-browser Babel), and Tailwind CSS (via the Tailwind CDN — use " +
      "utility classes like `flex`, `gap-4`, `rounded-lg`, `shadow`, `text-slate-600` freely) are already provided " +
      "by the generated page's CDN script tags. Use this instead of hand-writing the React/Babel CDN boilerplate " +
      "with write_file — it wraps `code` in that scaffold for you, writes the result as a self-contained HTML " +
      "file, and opens it through the same local server as preview_html (relative asset references still won't " +
      "work here since everything is one file — for a multi-file mockup with its own CSS/assets, use write_file " +
      "+ preview_html instead). Aim for a genuinely polished result, not just a functional one: real spacing, a " +
      "clear visual hierarchy, and an actual color/type choice instead of default black-on-white — Tailwind makes " +
      "this cheap, there's no excuse for a bare unstyled page. Follow up with browser_navigate + " +
      "browser_screenshot to actually see the rendered result before calling it done, same as any other UI work. " +
      "You can define as many helper components/functions as you want in `code` alongside `App` (e.g. " +
      "`function Header() {...} function App() { return <Header/>; }`) — ordinary JS scoping inside the one " +
      "script tag, nothing special needed. For a small change to an artifact you already created (a color, a " +
      "label, one handler), prefer edit_file on the same path instead of re-emitting the whole `code` — the JSX " +
      "ends up in the written file exactly as you passed it, byte for byte, so a snippet copied from the `code` " +
      "you sent before will match old_string/new_string cleanly. The page also polls itself and reloads " +
      "automatically when the file changes, so an edit_file change shows up in the already-open tab without " +
      "reopening it — reserve calling create_artifact again for a substantial rewrite.",
    riskLevel: "ask",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Where to write the generated HTML file, relative to the project root" },
        code: {
          type: "string",
          description: "JSX source defining a component named App (e.g. `function App() { return <div>hi</div>; }`)",
        },
        title: { type: "string", description: "Page title (defaults to the artifact's file name)" },
      },
      required: ["path", "code"],
    },
    riskKey: (input) => input.path,
    describeCall: (input) => `create artifact ${input.path}`,
    async preview(input, ctx) {
      const filePath = resolveAllowedPath(ctx.cwd, input.path);
      const before = await readFile(filePath, "utf-8").catch(() => "");
      const html = renderArtifactHtml(input.code, input.title ?? path.basename(input.path));
      return createTwoFilesPatch(input.path, input.path, before, html);
    },
    async handler(input, ctx) {
      const filePath = resolveAllowedPath(ctx.cwd, input.path);
      const html = renderArtifactHtml(input.code, input.title ?? path.basename(input.path));

      const existing = await readFile(filePath, "utf-8").then(
        (content) => ({ existed: true, content }),
        () => ({ existed: false, content: "" }),
      );
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, html, "utf-8");
      ctx.history?.push({ path: filePath, before: existing.existed ? existing.content : undefined });
      ctx.fileFreshness?.record(filePath, html);

      const relative = path.relative(ctx.cwd, filePath);
      const url = await server.urlFor(ctx.cwd, relative);
      openUrl(url);
      return { content: `Created artifact at ${input.path}, opened at ${url}`, isError: false };
    },
  };
}
