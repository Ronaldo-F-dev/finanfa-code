import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateNginxConfigTool, createTestNginxConfigTool } from "../../src/tools/builtin/nginx-config.js";

const FAKE_NGINX = fileURLToPath(new URL("../fixtures/fake-nginx.mjs", import.meta.url));
const MISSING_BIN = "/nonexistent/definitely-not-a-real-binary-xyz";

function braceBalance(content: string): number {
  return (content.match(/{/g) || []).length - (content.match(/}/g) || []).length;
}

describe("generate_nginx_config (pure template generation)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "finanfa-nginx-config-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const ctx = () => ({ cwd: dir, sessionId: "s", signal: new AbortController().signal });

  it("has a static 'ask' riskLevel (system-path vs. project-path distinction is carried by riskKey instead)", () => {
    expect(generateNginxConfigTool.riskLevel).toBe("ask");
  });

  it("writes a syntactically sensible config: balanced braces, server_name, location / with proxy_pass and standard headers", async () => {
    const outputPath = "nginx.conf";
    const result = await generateNginxConfigTool.handler(
      { serverName: "example.com", outputPath, options: { proxyPass: "http://localhost:3000" } },
      ctx(),
    );
    expect(result.isError).toBe(false);

    const content = await readFile(path.join(dir, outputPath), "utf-8");
    expect(braceBalance(content)).toBe(0);
    expect(content).toContain("http {");
    expect(content).toContain("events {");
    expect(content).toContain("server {");
    expect(content).toContain("server_name example.com;");
    expect(content).toContain("location / {");
    expect(content).toContain("proxy_pass http://localhost:3000;");
    expect(content).toContain("proxy_set_header Host $host;");
    expect(content).toContain("proxy_set_header X-Real-IP $remote_addr;");
    expect(content).toContain("proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;");
    expect(content).toContain("proxy_set_header X-Forwarded-Proto $scheme;");
  });

  it("includes ssl_certificate/ssl_certificate_key directives when ssl: true", async () => {
    const result = await generateNginxConfigTool.handler(
      {
        serverName: "example.com",
        outputPath: "ssl.conf",
        options: { ssl: true, sslCertPath: "/custom/cert.pem", sslKeyPath: "/custom/key.pem" },
      },
      ctx(),
    );
    expect(result.isError).toBe(false);
    const content = await readFile(path.join(dir, "ssl.conf"), "utf-8");
    expect(content).toContain("listen 443 ssl;");
    expect(content).toContain("ssl_certificate /custom/cert.pem;");
    expect(content).toContain("ssl_certificate_key /custom/key.pem;");
    expect(braceBalance(content)).toBe(0);
  });

  it("omits ssl directives entirely when ssl is false/omitted", async () => {
    const result = await generateNginxConfigTool.handler({ serverName: "example.com", outputPath: "plain.conf" }, ctx());
    expect(result.isError).toBe(false);
    const content = await readFile(path.join(dir, "plain.conf"), "utf-8");
    expect(content).not.toContain("ssl_certificate");
    expect(content).not.toContain("listen 443");
    expect(content).toContain("listen 80;");
  });

  describe("riskKey: system nginx path vs. project path", () => {
    it("gives a system-path (/etc/nginx/...) output a distinct riskKey", () => {
      expect(generateNginxConfigTool.riskKey?.({ serverName: "example.com", outputPath: "/etc/nginx/sites-available/example.com" })).toBe(
        "generate_nginx_config:system-path",
      );
    });

    it("gives a project-relative output path the plain tool-name riskKey", () => {
      expect(generateNginxConfigTool.riskKey?.({ serverName: "example.com", outputPath: "nginx.conf" })).toBe("generate_nginx_config");
      expect(generateNginxConfigTool.riskKey?.({ serverName: "example.com", outputPath: "./review/nginx.conf" })).toBe("generate_nginx_config");
    });

    it("describeCall flags a system-path output as implying actual deployment", () => {
      expect(
        generateNginxConfigTool.describeCall?.({ serverName: "example.com", outputPath: "/etc/nginx/sites-available/example.com" }),
      ).toContain("implies actual deployment");
      expect(generateNginxConfigTool.describeCall?.({ serverName: "example.com", outputPath: "nginx.conf" })).not.toContain(
        "implies actual deployment",
      );
    });
  });
});

describe("test_nginx_config (real subprocess, fake nginx stand-in)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "finanfa-test-nginx-config-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const ctx = () => ({ cwd: dir, sessionId: "s", signal: new AbortController().signal });

  it("has 'safe' risk level (pure validation, no reload/restart)", () => {
    const tool = createTestNginxConfigTool({ nginxBinary: FAKE_NGINX });
    expect(tool.riskLevel).toBe("safe");
  });

  it("reports a valid config as valid via the real nginx -t -c invocation (fake stand-in)", async () => {
    const configPath = path.join(dir, "valid.conf");
    await writeFile(configPath, "events {}\nhttp {\n  server {\n    server_name a;\n  }\n}\n", "utf-8");

    const tool = createTestNginxConfigTool({ nginxBinary: FAKE_NGINX });
    const result = await tool.handler({ configPath: "valid.conf" }, ctx());
    expect(result.isError).toBe(false);
    expect(result.content).toMatch(/test is successful/);
  });

  it("reports an invalid (unbalanced-brace) config as invalid", async () => {
    const configPath = path.join(dir, "invalid.conf");
    await writeFile(configPath, "events {}\nhttp {\n  server {\n    server_name a;\n", "utf-8");

    const tool = createTestNginxConfigTool({ nginxBinary: FAKE_NGINX });
    const result = await tool.handler({ configPath: "invalid.conf" }, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/emerg/);
  });

  it("reports nginx as unavailable, rather than crashing, when it's missing", async () => {
    const tool = createTestNginxConfigTool({ nginxBinary: MISSING_BIN });
    const result = await tool.handler({ configPath: "whatever.conf" }, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/nginx not available/i);
  });

  it("invokes nginx with -t -c <resolved path>", async () => {
    const configPath = path.join(dir, "valid.conf");
    await writeFile(configPath, "events {}\nhttp { server { server_name a; } }\n", "utf-8");

    const tool = createTestNginxConfigTool({ nginxBinary: FAKE_NGINX });
    const result = await tool.handler({ configPath: "valid.conf" }, ctx());
    expect(result.content).toContain(configPath);
  });
});
