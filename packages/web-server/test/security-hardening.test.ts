import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { killWebServer, spawnWebServer } from "./support/spawn-server.js";

// End-to-end checks of the server's attack surface against a REAL running server: each test
// reproduces one way a hostile page, a co-tenant or an unauthenticated caller could reach more
// than they should have (and asserts they now can't).

const SECRET = "TOP-SECRET-VALUE-9f3a";

/** Raw HTTP request, because fetch() won't let a caller set the Host header. */
function rawRequest(port: number, urlPath: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: urlPath, headers }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

function wsOutcome(url: string, headers: Record<string, string> = {}): Promise<{ opened: boolean; status?: number }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers });
    ws.on("open", () => {
      ws.close();
      resolve({ opened: true });
    });
    ws.on("unexpected-response", (_req, res) => resolve({ opened: false, status: res.statusCode }));
    ws.on("error", () => resolve({ opened: false }));
  });
}

describe("web-server hardening, no gateway auth (the default)", () => {
  let projectDir: string;
  let homeDir: string;
  let outsideDir: string;
  let child: ChildProcessWithoutNullStreams;
  let port: number;
  const base = () => `http://127.0.0.1:${port}`;

  beforeAll(async () => {
    projectDir = await mkdtemp(path.join(tmpdir(), "finanfa-sec-project-"));
    homeDir = await mkdtemp(path.join(tmpdir(), "finanfa-sec-home-"));
    outsideDir = await mkdtemp(path.join(tmpdir(), "finanfa-sec-outside-"));
    await writeFile(path.join(projectDir, "hello.txt"), "hello from the project");
    await mkdir(path.join(homeDir, ".ssh"), { recursive: true });
    await mkdir(path.join(homeDir, ".finanfa-code"), { recursive: true });
    await writeFile(path.join(homeDir, ".ssh", "id_rsa"), SECRET);
    await writeFile(path.join(homeDir, ".finanfa-code", "web-sessions.json"), SECRET);
    await writeFile(path.join(outsideDir, "outside.txt"), SECRET);
    // A perfectly ordinary, non-hidden file elsewhere in the home: Express's own dotfile rule never protected these.
    await writeFile(path.join(homeDir, "notes.txt"), SECRET);
    await symlink(path.join(outsideDir, "outside.txt"), path.join(projectDir, "link.txt"));
    ({ child, port } = await spawnWebServer(projectDir, homeDir));
  }, 30_000);

  afterAll(async () => {
    killWebServer(child);
    for (const d of [projectDir, homeDir, outsideDir]) await rm(d, { recursive: true, force: true });
  });

  describe("/api/workspace-file", () => {
    it("still serves a file inside the project", async () => {
      const res = await fetch(`${base()}/api/workspace-file?path=hello.txt`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("hello from the project");
    });

    it.each([
      ["an ordinary file elsewhere in the home directory", () => path.join(homeDir, "notes.txt")],
      ["an absolute path into ~/.ssh", () => path.join(homeDir, ".ssh", "id_rsa")],
      ["the server's session tokens", () => path.join(homeDir, ".finanfa-code", "web-sessions.json")],
      ["a relative traversal out of the project", () => "../" + path.basename(outsideDir) + "/outside.txt"],
      ["a symlink that points out of the project", () => "link.txt"],
      ["/etc/passwd", () => "/etc/passwd"],
    ])("refuses %s, without leaking the content", async (_label, pick) => {
      const res = await fetch(`${base()}/api/workspace-file?path=${encodeURIComponent(pick())}`);
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain(SECRET);
    });
  });

  describe("?project= / :id path traversal", () => {
    it.each(["../..", "../../..", "..", "%2e%2e"])("refuses the project id %s on every route that takes one", async (id) => {
      const enc = encodeURIComponent(id);
      const file = await fetch(`${base()}/api/workspace-file?project=${enc}&path=${encodeURIComponent(path.join(".finanfa-code", "web-sessions.json"))}`);
      expect(file.status).toBe(404);

      const zip = await fetch(`${base()}/api/projects/${enc}/download`);
      expect(zip.status).toBe(404);

      const read = await fetch(`${base()}/api/projects/${enc}/instructions`);
      expect(read.status).toBe(404);

      const write = await fetch(`${base()}/api/projects/${enc}/instructions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "pwned" }),
      });
      expect(write.status).toBe(404);
    });

    it("did not write finanfa.md anywhere above the projects directory", async () => {
      for (const dir of [homeDir, path.dirname(homeDir), path.join(homeDir, ".finanfa-code")]) {
        await expect(stat(path.join(dir, "finanfa.md"))).rejects.toThrow();
      }
    });
  });

  describe("websocket origin", () => {
    it("refuses a handshake from another site", async () => {
      expect(await wsOutcome(`ws://127.0.0.1:${port}/ws?model=m`, { Origin: "http://evil.example" })).toEqual({ opened: false, status: 403 });
    });

    it("refuses an opaque origin", async () => {
      expect((await wsOutcome(`ws://127.0.0.1:${port}/ws?model=m`, { Origin: "null" })).opened).toBe(false);
    });

    it("accepts the server's own origin, and a client that sends no Origin (CLI, scripts)", async () => {
      expect((await wsOutcome(`ws://127.0.0.1:${port}/ws?model=m`, { Origin: `http://127.0.0.1:${port}` })).opened).toBe(true);
      expect((await wsOutcome(`ws://127.0.0.1:${port}/ws?model=m`)).opened).toBe(true);
    });
  });

  describe("DNS rebinding", () => {
    it("refuses a request whose Host is not a loopback name", async () => {
      const res = await rawRequest(port, "/api/models", { Host: `attacker.example:${port}` });
      expect(res.status).toBe(403);
    });

    it("refuses a rebound Host on the websocket too, even with a matching Origin", async () => {
      const outcome = await wsOutcome(`ws://127.0.0.1:${port}/ws?model=m`, { Host: `attacker.example:${port}`, Origin: `http://attacker.example:${port}` });
      expect(outcome).toEqual({ opened: false, status: 403 });
    });

    it("accepts the loopback names", async () => {
      for (const host of [`localhost:${port}`, `127.0.0.1:${port}`]) expect((await rawRequest(port, "/api/projects", { Host: host })).status).toBe(200);
    });
  });

  describe("network exposure", () => {
    const external = Object.values(os.networkInterfaces())
      .flat()
      .find((i) => i && i.family === "IPv4" && !i.internal)?.address;

    it.skipIf(!external)("does not accept connections on a non-loopback interface by default", async () => {
      const outcome = await new Promise<string>((resolve) => {
        const socket = net.connect({ host: external!, port, timeout: 3000 });
        socket.on("connect", () => {
          socket.destroy();
          resolve("connected");
        });
        socket.on("error", (e) => resolve((e as NodeJS.ErrnoException).code ?? "error"));
        socket.on("timeout", () => {
          socket.destroy();
          resolve("timeout");
        });
      });
      expect(outcome).toBe("ECONNREFUSED");
    });
  });
});

describe("web-server hardening, gateway auth ON", () => {
  let projectDir: string;
  let homeDir: string;
  let child: ChildProcessWithoutNullStreams;
  let port: number;
  const base = () => `http://127.0.0.1:${port}`;

  beforeAll(async () => {
    projectDir = await mkdtemp(path.join(tmpdir(), "finanfa-sec-gw-project-"));
    homeDir = await mkdtemp(path.join(tmpdir(), "finanfa-sec-gw-home-"));
    ({ child, port } = await spawnWebServer(projectDir, homeDir, { FINANFA_WEB_USERS: "alice:tok-alice" }));
  }, 30_000);

  afterAll(async () => {
    killWebServer(child);
    await rm(projectDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  it("requires the bearer token to read the channels config, and to write it", async () => {
    expect((await fetch(`${base()}/api/channels-config`)).status).toBe(401);
    expect((await fetch(`${base()}/api/tunnel-url`)).status).toBe(401);
    const write = await fetch(`${base()}/api/channels-config/telegram`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ TELEGRAM_BOT_TOKEN: "attacker-token" }),
    });
    expect(write.status).toBe(401);
    expect((await fetch(`${base()}/api/channels-config/discord/register-command`, { method: "POST" })).status).toBe(401);
    // ...and nothing was persisted by the refused write.
    await expect(readFile(path.join(homeDir, ".finanfa-code", "config.json"), "utf-8")).rejects.toThrow();
  });

  it("still works with a valid token", async () => {
    const res = await fetch(`${base()}/api/channels-config`, { headers: { Authorization: "Bearer tok-alice" } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { channels: unknown[] }).channels.length).toBeGreaterThan(0);
  });

  it("leaves a channel's inbound webhook to its own signature check, not the bearer gate", async () => {
    // Unsigned and unconfigured: the route answers on its own terms — anything but the gate's 401.
    const res = await fetch(`${base()}/api/channels/telegram/webhook`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).not.toBe(401);
  });
});
