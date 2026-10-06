import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  checkRequestHost,
  checkWebSocketOrigin,
  hostnameOf,
  isLoopbackBind,
  parseAllowedOrigins,
  resolveWorkspaceFile,
  WorkspaceFileError,
  type OriginPolicy,
} from "../src/security.js";

const loopback: OriginPolicy = { loopbackBound: true, allowedOrigins: [] };

describe("isLoopbackBind", () => {
  it("is true only for addresses that accept local connections", () => {
    for (const h of ["127.0.0.1", "localhost", "::1", "[::1]", "127.0.0.2"]) expect(isLoopbackBind(h)).toBe(true);
    for (const h of ["0.0.0.0", "::", "192.168.1.5", "example.com"]) expect(isLoopbackBind(h)).toBe(false);
  });
});

describe("hostnameOf / parseAllowedOrigins", () => {
  it("strips ports and brackets", () => {
    expect(hostnameOf("Localhost:4600")).toBe("localhost");
    expect(hostnameOf("[::1]:4600")).toBe("::1");
    expect(hostnameOf(undefined)).toBeUndefined();
    expect(hostnameOf("bad host")).toBeUndefined();
  });

  it("normalizes valid origins and drops the rest", () => {
    expect(parseAllowedOrigins("http://localhost:5173/, https://app.example.com ,nonsense,")).toEqual(["http://localhost:5173", "https://app.example.com"]);
    expect(parseAllowedOrigins(undefined)).toEqual([]);
  });
});

describe("checkRequestHost (DNS rebinding)", () => {
  it("lets loopback names through a loopback-bound server, and refuses a rebound domain", () => {
    expect(checkRequestHost("localhost:4600", loopback)).toBe(true);
    expect(checkRequestHost("127.0.0.1:4600", loopback)).toBe(true);
    expect(checkRequestHost("[::1]:4600", loopback)).toBe(true);
    expect(checkRequestHost("attacker.example:4600", loopback)).toBe(false);
    expect(checkRequestHost(undefined, loopback)).toBe(false);
  });

  it("accepts allowed origins' hostnames and dynamic extra hostnames (the tunnel)", () => {
    const policy: OriginPolicy = { loopbackBound: true, allowedOrigins: ["https://app.example.com"], extraHostnames: () => ["abc.trycloudflare.com"] };
    expect(checkRequestHost("app.example.com", policy)).toBe(true);
    expect(checkRequestHost("ABC.trycloudflare.com", policy)).toBe(true);
    expect(checkRequestHost("other.example.com", policy)).toBe(false);
  });

  it("does not apply to a non-loopback bind, which relies on auth", () => {
    expect(checkRequestHost("anything.example", { loopbackBound: false, allowedOrigins: [] })).toBe(true);
  });
});

describe("checkWebSocketOrigin", () => {
  it("allows a non-browser client (no Origin header)", () => {
    expect(checkWebSocketOrigin(undefined, "localhost:4600", loopback)).toBe(true);
  });

  it("allows the server's own origin and refuses any other site", () => {
    expect(checkWebSocketOrigin("http://localhost:4600", "localhost:4600", loopback)).toBe(true);
    expect(checkWebSocketOrigin("http://evil.example", "localhost:4600", loopback)).toBe(false);
    expect(checkWebSocketOrigin("http://localhost:3000", "localhost:4600", loopback)).toBe(false); // another local app is not this one
  });

  it("refuses an opaque or malformed origin", () => {
    expect(checkWebSocketOrigin("null", "localhost:4600", loopback)).toBe(false);
    expect(checkWebSocketOrigin("garbage", "localhost:4600", loopback)).toBe(false);
  });

  it("allows an explicitly allowed origin", () => {
    expect(checkWebSocketOrigin("http://localhost:3000", "localhost:4600", { ...loopback, allowedOrigins: ["http://localhost:3000"] })).toBe(true);
  });
});

describe("resolveWorkspaceFile", () => {
  async function project() {
    const home = await mkdtemp(path.join(tmpdir(), "finanfa-wsfile-"));
    const cwd = path.join(home, "project");
    await mkdir(path.join(cwd, "sub"), { recursive: true });
    await mkdir(path.join(cwd, ".finanfa-code"), { recursive: true });
    await mkdir(path.join(home, ".ssh"), { recursive: true });
    await writeFile(path.join(cwd, "a.txt"), "ok");
    await writeFile(path.join(cwd, "sub", "b.txt"), "ok");
    await writeFile(path.join(cwd, ".env"), "SECRET=1");
    await writeFile(path.join(cwd, ".env.local"), "SECRET=2");
    await writeFile(path.join(cwd, ".finanfa-code", "config.json"), "{}");
    await writeFile(path.join(home, ".ssh", "id_rsa"), "PRIVATE");
    await writeFile(path.join(home, "outside.txt"), "outside");
    return { home, cwd };
  }

  it("serves files inside the project, including nested ones", async () => {
    const { cwd } = await project();
    expect(await resolveWorkspaceFile(cwd, "a.txt")).toMatch(/a\.txt$/);
    expect(await resolveWorkspaceFile(cwd, "sub/b.txt")).toMatch(/b\.txt$/);
  });

  it("refuses anything outside the project: parent traversal, absolute paths, the home directory", async () => {
    const { home, cwd } = await project();
    for (const bad of ["../outside.txt", "../.ssh/id_rsa", path.join(home, ".ssh", "id_rsa"), path.join(home, "outside.txt"), "/etc/passwd", "sub/../../outside.txt"]) {
      await expect(resolveWorkspaceFile(cwd, bad)).rejects.toBeInstanceOf(WorkspaceFileError);
    }
  });

  it("refuses credential locations even inside the project", async () => {
    const { cwd } = await project();
    for (const bad of [".env", ".env.local", ".finanfa-code/config.json"]) {
      await expect(resolveWorkspaceFile(cwd, bad)).rejects.toBeInstanceOf(WorkspaceFileError);
    }
  });

  it("refuses a symlink that points out of the project", async () => {
    const { home, cwd } = await project();
    await symlink(path.join(home, ".ssh", "id_rsa"), path.join(cwd, "innocent.txt"));
    await symlink(path.join(home, ".ssh"), path.join(cwd, "linkdir"));
    await expect(resolveWorkspaceFile(cwd, "innocent.txt")).rejects.toBeInstanceOf(WorkspaceFileError);
    await expect(resolveWorkspaceFile(cwd, "linkdir/id_rsa")).rejects.toBeInstanceOf(WorkspaceFileError);
  });

  it("refuses a missing file and a NUL byte with the same generic message", async () => {
    const { cwd } = await project();
    await expect(resolveWorkspaceFile(cwd, "nope.txt")).rejects.toThrow("File not found or not accessible.");
    await expect(resolveWorkspaceFile(cwd, "a.txt\0.png")).rejects.toThrow("File not found or not accessible.");
  });
});
