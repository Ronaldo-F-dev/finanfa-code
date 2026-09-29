import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readEnvFileTool, setEnvValueTool, listEnvFilesTool, parseEnvContent, patchEnvContent } from "../../src/tools/builtin/env-secrets.js";

const ctx = (dir: string) => ({ cwd: dir, sessionId: "s", signal: new AbortController().signal });

describe("parseEnvContent", () => {
  it("extracts KEY=VALUE pairs, skips comments/blank lines, and unquotes values", () => {
    const content = [
      "# a comment",
      "",
      "API_KEY=sho_secret_1234",
      'QUOTED="has a space"',
      "SINGLE='literal $no expansion'",
      "export EXPORTED=exported_value",
      "TRAILING=value # inline comment",
    ].join("\n");
    const entries = parseEnvContent(content);
    expect(entries.get("API_KEY")).toBe("sho_secret_1234");
    expect(entries.get("QUOTED")).toBe("has a space");
    expect(entries.get("SINGLE")).toBe("literal $no expansion");
    expect(entries.get("EXPORTED")).toBe("exported_value");
    expect(entries.get("TRAILING")).toBe("value");
    expect(entries.size).toBe(5);
  });
});

describe("patchEnvContent", () => {
  it("patches an existing key's line, leaving every other line untouched", () => {
    const before = ["# header comment", "FOO=old", "BAR=unrelated", ""].join("\n");
    const { content, created } = patchEnvContent(before, "FOO", "new");
    expect(created).toBe(false);
    expect(content.split("\n")).toEqual(["# header comment", "FOO=new", "BAR=unrelated", ""]);
  });

  it("appends a new key when it isn't present, without introducing a stray blank line", () => {
    const before = ["FOO=old", ""].join("\n");
    const { content, created } = patchEnvContent(before, "BAZ", "value");
    expect(created).toBe(true);
    expect(content.split("\n")).toEqual(["FOO=old", "BAZ=value"]);
  });

  it("quotes a value that needs it (contains whitespace)", () => {
    const { content } = patchEnvContent("", "KEY", "has space");
    expect(content).toBe('KEY="has space"');
  });
});

describe("env-secrets tools (real temp .env files)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "finanfa-env-secrets-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("read_env_file masks values by default", async () => {
    await writeFile(path.join(dir, ".env"), "API_KEY=shopify_super_secret_value\nSHORT=ab\n", "utf-8");
    const result = await readEnvFileTool.handler({ path: ".env" }, ctx(dir));
    expect(result.isError).toBe(false);
    expect(result.content).not.toContain("shopify_super_secret_value");
    expect(result.content).toContain("API_KEY=");
    // first 6 + last 4 chars survive masking, per security/patterns.ts's mask()
    expect(result.content).toContain("shopif");
    expect(result.content).toContain("alue");
    // a short value (<=10 chars) is masked entirely, per mask()'s own rule
    expect(result.content).toContain("SHORT=**");
    expect(result.content).not.toContain("SHORT=ab");
  });

  it("read_env_file with unmask: true reveals the real value", async () => {
    await writeFile(path.join(dir, ".env"), "API_KEY=shopify_super_secret_value\n", "utf-8");
    const result = await readEnvFileTool.handler({ path: ".env", unmask: true }, ctx(dir));
    expect(result.isError).toBe(false);
    expect(result.content).toContain("API_KEY=shopify_super_secret_value");
  });

  it("the tool description warns that unmask exposes real secrets", () => {
    expect(readEnvFileTool.description.toLowerCase()).toContain("unmask");
    expect(readEnvFileTool.description.toLowerCase()).toMatch(/real|expose/);
  });

  it("set_env_value updates an existing key and masks the value in its own result", async () => {
    await writeFile(path.join(dir, ".env"), "# keep me\nFOO=old\nBAR=unrelated\n", "utf-8");
    const result = await setEnvValueTool.handler({ path: ".env", key: "FOO", value: "brand_new_secret" }, ctx(dir));
    expect(result.isError).toBe(false);
    expect(result.content).not.toContain("brand_new_secret");
    const written = await readFile(path.join(dir, ".env"), "utf-8");
    expect(written).toBe("# keep me\nFOO=brand_new_secret\nBAR=unrelated\n");
  });

  it("set_env_value appends a new key when missing, preserving the rest of the file", async () => {
    await writeFile(path.join(dir, ".env"), "FOO=old\n", "utf-8");
    const result = await setEnvValueTool.handler({ path: ".env", key: "NEW_KEY", value: "value" }, ctx(dir));
    expect(result.isError).toBe(false);
    const written = await readFile(path.join(dir, ".env"), "utf-8");
    expect(written).toBe("FOO=old\nNEW_KEY=value");
  });

  it("set_env_value creates the file if it doesn't exist yet", async () => {
    const result = await setEnvValueTool.handler({ path: "new.env", key: "KEY", value: "value" }, ctx(dir));
    expect(result.isError).toBe(false);
    expect(await readFile(path.join(dir, "new.env"), "utf-8")).toBe("KEY=value");
  });

  it("list_env_files finds .env/.env.* files and excludes node_modules/.git, reporting keys but not values", async () => {
    await writeFile(path.join(dir, ".env"), "API_KEY=secretvalue\nDB_HOST=localhost\n", "utf-8");
    await writeFile(path.join(dir, ".env.production"), "PROD_SECRET=another_secret\n", "utf-8");
    await mkdir(path.join(dir, "node_modules", "somepkg"), { recursive: true });
    await writeFile(path.join(dir, "node_modules", "somepkg", ".env"), "SHOULD_NOT_APPEAR=x\n", "utf-8");
    await mkdir(path.join(dir, ".git"), { recursive: true });
    await writeFile(path.join(dir, ".git", ".env"), "SHOULD_NOT_APPEAR=x\n", "utf-8");

    const result = await listEnvFilesTool.handler({}, ctx(dir));
    expect(result.isError).toBe(false);
    expect(result.content).toContain(".env:");
    expect(result.content).toContain("API_KEY");
    expect(result.content).toContain("DB_HOST");
    expect(result.content).toContain(".env.production");
    expect(result.content).toContain("PROD_SECRET");
    expect(result.content).not.toContain("secretvalue");
    expect(result.content).not.toContain("another_secret");
    expect(result.content).not.toContain("SHOULD_NOT_APPEAR");
    expect(result.content).not.toContain("node_modules");
  });

  it("list_env_files has riskLevel safe, set_env_value/read_env_file are ask", () => {
    expect(listEnvFilesTool.riskLevel).toBe("safe");
    expect(setEnvValueTool.riskLevel).toBe("ask");
    expect(readEnvFileTool.riskLevel).toBe("ask");
  });
});
