import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  createPublishBundleToRegistryTool,
  createListRegistryBundlesTool,
  createListRegistryBundleVersionsTool,
  createInstallBundleFromRegistryTool,
} from "../../src/tools/builtin/claws-registry-tools.js";
import type { ClawBundle } from "../../src/core/claw-bundle.js";

function makeBundle(name: string, version: string): ClawBundle {
  return { manifest: { name, version, createdAt: new Date().toISOString(), sourceProjectPath: "/tmp/project" }, files: { "finanfa.md": `# ${name}` } };
}

describe("claws registry tools — not configured", () => {
  it("publish_bundle_to_registry reports a clear error instead of throwing", async () => {
    const tool = createPublishBundleToRegistryTool({});
    const ctx = { cwd: "/tmp", sessionId: "s", signal: new AbortController().signal };
    const result = await tool.handler({ owner: "acme", repo: "claws-registry", bundle_json: JSON.stringify(makeBundle("acme", "1.0.0")) }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("CLAWS_REGISTRY_TOKEN");
  });
});

describe("claws registry tools (real local HTTP server speaking GitHub's Contents API shape)", () => {
  let server: http.Server;
  let baseUrl: string;
  let dir: string;
  let files: Map<string, { content: string }>;
  let dirs: Map<string, { name: string; type: "file" | "dir" }[]>;
  const ctx = () => ({ cwd: dir, sessionId: "s", signal: new AbortController().signal });

  beforeEach(async () => {
    files = new Map();
    dirs = new Map();
    dir = await mkdtemp(path.join(tmpdir(), "finanfa-claws-registry-tools-"));

    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const url = new URL(req.url ?? "", "http://x");
        const prefix = "/repos/acme/claws-registry/contents/";
        if (!url.pathname.startsWith(prefix)) {
          res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ message: "Not Found" }));
          return;
        }
        const filePath = decodeURIComponent(url.pathname.slice(prefix.length));

        if (req.method === "PUT") {
          const parsed = JSON.parse(body) as { content: string };
          files.set(filePath, { content: parsed.content });
          res.writeHead(201, { "content-type": "application/json" });
          res.end(JSON.stringify({ content: { path: filePath }, commit: { sha: "abc123commit" } }));
          return;
        }

        if (dirs.has(filePath)) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(dirs.get(filePath)));
          return;
        }
        const file = files.get(filePath);
        if (file) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ type: "file", name: filePath.split("/").pop(), encoding: "base64", content: file.content, sha: "filesha" }));
          return;
        }
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ message: "Not Found" }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    server.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("publish_bundle_to_registry publishes a real bundle and reports success", async () => {
    const tool = createPublishBundleToRegistryTool({ token: "ghp_real-looking-token" }, baseUrl);
    const bundle = makeBundle("acme-conventions", "1.0.0");
    const result = await tool.handler({ owner: "acme", repo: "claws-registry", bundle_json: JSON.stringify(bundle) }, ctx());
    expect(result.isError).toBe(false);
    expect(result.content).toContain('Published "acme-conventions@1.0.0"');
    expect(files.has("bundles/acme-conventions/1.0.0.json")).toBe(true);
  });

  it("publish_bundle_to_registry rejects unparseable JSON with a clear error instead of throwing", async () => {
    const tool = createPublishBundleToRegistryTool({ token: "t" }, baseUrl);
    const result = await tool.handler({ owner: "acme", repo: "claws-registry", bundle_json: "not json" }, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Not valid bundle JSON");
  });

  it("list_registry_bundles reports every published bundle name", async () => {
    dirs.set("bundles", [
      { name: "acme-conventions", type: "dir" },
      { name: "other-bundle", type: "dir" },
    ]);
    const tool = createListRegistryBundlesTool({}, baseUrl);
    const result = await tool.handler({ owner: "acme", repo: "claws-registry" }, ctx());
    expect(result.isError).toBe(false);
    expect(result.content).toBe("acme-conventions\nother-bundle");
  });

  it("list_registry_bundles reports plainly when the registry is empty", async () => {
    const tool = createListRegistryBundlesTool({}, baseUrl);
    const result = await tool.handler({ owner: "acme", repo: "claws-registry" }, ctx());
    expect(result.isError).toBe(false);
    expect(result.content).toContain("No bundles published");
  });

  it("list_registry_bundle_versions reports every published version, newest first", async () => {
    dirs.set("bundles/acme-conventions", [
      { name: "1.0.0.json", type: "file" },
      { name: "2.0.0.json", type: "file" },
    ]);
    const tool = createListRegistryBundleVersionsTool({}, baseUrl);
    const result = await tool.handler({ owner: "acme", repo: "claws-registry", name: "acme-conventions" }, ctx());
    expect(result.isError).toBe(false);
    expect(result.content).toBe("2.0.0\n1.0.0");
  });

  it("install_bundle_from_registry fetches a bundle from the registry and installs it into the project", async () => {
    const bundle = makeBundle("acme-conventions", "1.0.0");
    files.set("bundles/acme-conventions/1.0.0.json", { content: Buffer.from(JSON.stringify(bundle)).toString("base64") });

    const tool = createInstallBundleFromRegistryTool({}, baseUrl);
    const result = await tool.handler({ owner: "acme", repo: "claws-registry", name: "acme-conventions", version: "1.0.0" }, ctx());
    expect(result.isError).toBe(false);
    expect(result.content).toContain('Installed "acme-conventions@1.0.0" from acme/claws-registry');
    expect(await readFile(path.join(dir, "finanfa.md"), "utf-8")).toBe("# acme-conventions");
  });

  it("install_bundle_from_registry reports a real registry error instead of throwing", async () => {
    const tool = createInstallBundleFromRegistryTool({}, baseUrl);
    const result = await tool.handler({ owner: "acme", repo: "claws-registry", name: "nonexistent" }, ctx());
    expect(result.isError).toBe(true);
  });

  it("has the expected risk levels: ask to publish, safe to list, dangerous to install", () => {
    expect(createPublishBundleToRegistryTool({}).riskLevel).toBe("ask");
    expect(createListRegistryBundlesTool({}).riskLevel).toBe("safe");
    expect(createListRegistryBundleVersionsTool({}).riskLevel).toBe("safe");
    expect(createInstallBundleFromRegistryTool({}).riskLevel).toBe("dangerous");
  });
});
