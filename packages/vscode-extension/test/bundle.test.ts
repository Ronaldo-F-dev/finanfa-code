import { describe, expect, it, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const extensionDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const bundlePath = path.join(extensionDir, "dist", "extension.cjs");

// Real reported class of bug (found while building this): @finanfa/core has
// module-top-level `createRequire(import.meta.url)` calls that would throw
// the instant this bundle loads — not just when the specific tool using
// them runs — because esbuild's CJS output format leaves `import.meta`
// empty (see esbuild.config.mjs's inject/define workaround). `npm run
// build` succeeding is not proof the bundle actually loads: esbuild only
// warns about `import.meta.url`, it doesn't fail the build. This test
// actually requires the real compiled dist/extension.cjs in a real child
// Node process (mocking only the `vscode` module, which the extension host
// normally provides and which isn't installable as a real npm package) —
// the one test that would have caught the crash before ever pressing F5.
describe("dist/extension.cjs (the real compiled bundle) loads without crashing", () => {
  let fakeVscodeDir: string;

  beforeAll(async () => {
    // npm run build (packages/vscode-extension) must have already produced
    // dist/extension.cjs — same precondition every other "real bundle"
    // check in this project has (e.g. web-client's build output).
    execFileSync("npm", ["run", "build"], { cwd: extensionDir, stdio: "inherit" });

    fakeVscodeDir = await mkdtemp(path.join(tmpdir(), "finanfa-vscode-fake-module-"));
    await mkdir(path.join(fakeVscodeDir, "node_modules"), { recursive: true });
    // Minimal stub of the real `vscode` module — just enough surface for
    // extension.ts/chat-view-provider.ts's module-level code (none of it
    // actually calls into vscode.* until activate() runs, which this test
    // deliberately does NOT call — it only proves the module loads).
    await writeFile(
      path.join(fakeVscodeDir, "node_modules", "vscode.js"),
      "module.exports = { window: {}, workspace: {}, ExtensionContext: class {} };",
    );
  });

  it("require()s successfully and exports activate/deactivate as functions", () => {
    const script = `
      const mod = require(${JSON.stringify(bundlePath)});
      if (typeof mod.activate !== "function") throw new Error("activate is not a function: " + typeof mod.activate);
      if (typeof mod.deactivate !== "function") throw new Error("deactivate is not a function: " + typeof mod.deactivate);
      console.log("OK");
    `;
    const output = execFileSync(process.execPath, ["-e", script], {
      env: { ...process.env, NODE_PATH: path.join(fakeVscodeDir, "node_modules") },
      encoding: "utf-8",
    });
    expect(output.trim()).toBe("OK");
  });
});
