import { describe, expect, it, beforeEach, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  registryConfigFromEnv,
  publishBundleToRegistry,
  listRegistryBundles,
  listRegistryBundleVersions,
  fetchRegistryBundle,
  type ClawsRegistryTarget,
} from "../../src/core/claws-registry.js";
import type { ClawBundle } from "../../src/core/claw-bundle.js";

describe("registryConfigFromEnv", () => {
  it("has no token when CLAWS_REGISTRY_TOKEN isn't set", () => {
    expect(registryConfigFromEnv({})).toEqual({ token: undefined });
  });

  it("picks up a real env-var-shaped token", () => {
    expect(registryConfigFromEnv({ CLAWS_REGISTRY_TOKEN: "ghp_abc" } as NodeJS.ProcessEnv)).toEqual({ token: "ghp_abc" });
  });
});

function makeBundle(name: string, version: string): ClawBundle {
  return { manifest: { name, version, createdAt: new Date().toISOString(), sourceProjectPath: "/tmp/project" }, files: { "finanfa.md": "# hello" } };
}

// A fake local server speaking just enough of GitHub's real Contents API
// shape (GET a file/dir, PUT to create a file) for these tests — the
// same "test a real HTTP client against a real fake server, don't mock
// fetch" convention this codebase already uses (see replicate.test.ts).
describe("claws-registry (real local HTTP server speaking GitHub's Contents API shape)", () => {
  let server: http.Server;
  let baseUrl: string;
  // path -> { type: "file", content: base64 } | { type: "dir", entries: [{name, type}] }
  let files: Map<string, { content: string }>;
  let dirs: Map<string, { name: string; type: "file" | "dir" }[]>;
  let lastRequest: { method: string | undefined; url: string | undefined; authHeader: string | undefined; body: string } | undefined;
  let target: ClawsRegistryTarget;

  beforeEach(async () => {
    files = new Map();
    dirs = new Map();
    lastRequest = undefined;
    target = { owner: "acme", repo: "claws-registry" };

    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        lastRequest = { method: req.method, url: req.url, authHeader: req.headers.authorization, body };
        const url = new URL(req.url ?? "", baseUrl);
        const prefix = `/repos/${target.owner}/${target.repo}/contents/`;
        if (!url.pathname.startsWith(prefix)) {
          res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ message: "Not Found" }));
          return;
        }
        const path = decodeURIComponent(url.pathname.slice(prefix.length));

        if (req.method === "PUT") {
          const parsed = JSON.parse(body) as { content: string };
          files.set(path, { content: parsed.content });
          res.writeHead(201, { "content-type": "application/json" });
          res.end(JSON.stringify({ content: { path }, commit: { sha: "abc123commit" } }));
          return;
        }

        if (dirs.has(path)) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(dirs.get(path)));
          return;
        }
        const file = files.get(path);
        if (file) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ type: "file", name: path.split("/").pop(), encoding: "base64", content: file.content, sha: "filesha" }));
          return;
        }
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ message: "Not Found" }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(() => {
    server.close();
  });

  it("publishBundleToRegistry refuses without a token, without making a real request", async () => {
    const result = await publishBundleToRegistry({}, target, makeBundle("acme-conventions", "1.0.0"), baseUrl);
    expect(result).toEqual({ ok: false, error: expect.stringContaining("CLAWS_REGISTRY_TOKEN") });
    expect(lastRequest).toBeUndefined();
  });

  it("publishes a new bundle as a real authenticated commit via the Contents API", async () => {
    const bundle = makeBundle("acme-conventions", "1.0.0");
    const result = await publishBundleToRegistry({ token: "ghp_real-looking-token" }, target, bundle, baseUrl);
    expect(result).toEqual({ ok: true, value: { commitSha: "abc123commit" } });
    expect(lastRequest?.method).toBe("PUT");
    expect(lastRequest?.authHeader).toBe("Bearer ghp_real-looking-token");
    expect(lastRequest?.url).toBe("/repos/acme/claws-registry/contents/bundles/acme-conventions/1.0.0.json");

    const stored = files.get("bundles/acme-conventions/1.0.0.json");
    expect(JSON.parse(Buffer.from(stored!.content, "base64").toString("utf-8"))).toEqual(bundle);
  });

  it("refuses to publish over an already-published version", async () => {
    files.set("bundles/acme-conventions/1.0.0.json", { content: Buffer.from(JSON.stringify(makeBundle("acme-conventions", "1.0.0"))).toString("base64") });
    const result = await publishBundleToRegistry({ token: "t" }, target, makeBundle("acme-conventions", "1.0.0"), baseUrl);
    expect(result).toEqual({ ok: false, error: expect.stringContaining("already published") });
  });

  it("listRegistryBundles reports an empty registry (no bundles/ dir yet) as ok, not an error", async () => {
    const result = await listRegistryBundles({}, target, baseUrl);
    expect(result).toEqual({ ok: true, value: [] });
  });

  it("listRegistryBundles lists every published bundle name", async () => {
    dirs.set("bundles", [
      { name: "acme-conventions", type: "dir" },
      { name: "other-bundle", type: "dir" },
      { name: "README.md", type: "file" },
    ]);
    const result = await listRegistryBundles({}, target, baseUrl);
    expect(result).toEqual({ ok: true, value: ["acme-conventions", "other-bundle"] });
  });

  it("listRegistryBundleVersions reports every version, newest first", async () => {
    dirs.set("bundles/acme-conventions", [
      { name: "1.0.0.json", type: "file" },
      { name: "2.0.0.json", type: "file" },
      { name: "1.5.0.json", type: "file" },
    ]);
    const result = await listRegistryBundleVersions({}, target, "acme-conventions", baseUrl);
    expect(result).toEqual({ ok: true, value: ["2.0.0", "1.5.0", "1.0.0"] });
  });

  it("listRegistryBundleVersions reports a clear error for a bundle name that doesn't exist", async () => {
    const result = await listRegistryBundleVersions({}, target, "nonexistent", baseUrl);
    expect(result).toEqual({ ok: false, error: expect.stringContaining("No bundle named") });
  });

  it("fetchRegistryBundle fetches an exact published version", async () => {
    const bundle = makeBundle("acme-conventions", "1.0.0");
    files.set("bundles/acme-conventions/1.0.0.json", { content: Buffer.from(JSON.stringify(bundle)).toString("base64") });
    const result = await fetchRegistryBundle({}, target, "acme-conventions", "1.0.0", baseUrl);
    expect(result).toEqual({ ok: true, value: bundle });
  });

  it("fetchRegistryBundle defaults to the highest published version when none is given", async () => {
    const v1 = makeBundle("acme-conventions", "1.0.0");
    const v2 = makeBundle("acme-conventions", "2.0.0");
    files.set("bundles/acme-conventions/1.0.0.json", { content: Buffer.from(JSON.stringify(v1)).toString("base64") });
    files.set("bundles/acme-conventions/2.0.0.json", { content: Buffer.from(JSON.stringify(v2)).toString("base64") });
    dirs.set("bundles/acme-conventions", [
      { name: "1.0.0.json", type: "file" },
      { name: "2.0.0.json", type: "file" },
    ]);
    const result = await fetchRegistryBundle({}, target, "acme-conventions", undefined, baseUrl);
    expect(result).toEqual({ ok: true, value: v2 });
  });

  it("fetchRegistryBundle reports a clear error for a version that isn't published", async () => {
    const result = await fetchRegistryBundle({}, target, "acme-conventions", "9.9.9", baseUrl);
    expect(result).toEqual({ ok: false, error: expect.stringContaining("isn't published") });
  });
});
