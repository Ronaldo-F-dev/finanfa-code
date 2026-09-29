import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ToolDefinition } from "../../core/types.js";
import { resolveAllowedPath } from "./path-guard.js";
import { isCommandAvailable } from "../../util/command-availability.js";
import { runSubprocess } from "../../util/process.js";

// Pure template generation (generate_nginx_config) plus a real, safe,
// read-only validation wrapper (test_nginx_config) around the real nginx
// binary. Deliberately does NOT implement `systemctl reload nginx` or any
// other live-reload/restart action here — that needs system/root access
// this tool has no business assuming, and reload is a wholly separate,
// much riskier capability (it can affect production traffic on a real
// host) from generating and validating a config file for review.

// A path that looks like a real system nginx config directory implies the
// caller intends to actually deploy the file, not merely review it inside
// the project — same "path shape signals intent" idea write_file/
// path-guard already lean on, just surfaced here as a distinct riskKey (à
// la security_run_nmap's dos-script riskKey) rather than a blanket "ask"
// for every path, since there's no clean existing "dynamic riskLevel by
// input" precedent elsewhere in this codebase to reuse directly.
const SYSTEM_NGINX_PATH_RE = /^\/etc\/nginx\//;

export interface GenerateNginxConfigOptions {
  proxyPass?: string;
  ssl?: boolean;
  sslCertPath?: string;
  sslKeyPath?: string;
}

function isSystemNginxPath(outputPath: string): boolean {
  return SYSTEM_NGINX_PATH_RE.test(outputPath);
}

function serverBlock(serverName: string, options: GenerateNginxConfigOptions): string {
  const lines: string[] = ["  server {"];

  if (options.ssl) {
    lines.push("    listen 443 ssl;");
    lines.push("    listen [::]:443 ssl;");
  } else {
    lines.push("    listen 80;");
    lines.push("    listen [::]:80;");
  }
  lines.push(`    server_name ${serverName};`);

  if (options.ssl) {
    lines.push(`    ssl_certificate ${options.sslCertPath ?? "/etc/nginx/ssl/fullchain.pem"};`);
    lines.push(`    ssl_certificate_key ${options.sslKeyPath ?? "/etc/nginx/ssl/privkey.pem"};`);
  }

  lines.push("");
  lines.push("    location / {");
  if (options.proxyPass) {
    lines.push(`      proxy_pass ${options.proxyPass};`);
    lines.push("      proxy_set_header Host $host;");
    lines.push("      proxy_set_header X-Real-IP $remote_addr;");
    lines.push("      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;");
    lines.push("      proxy_set_header X-Forwarded-Proto $scheme;");
  } else {
    lines.push("      root /var/www/html;");
    lines.push("      index index.html;");
  }
  lines.push("    }");
  lines.push("  }");
  return lines.join("\n");
}

/**
 * A complete, standalone nginx config (events{} + http{} wrapping the
 * server{} block), not a bare server-block snippet — so the file this
 * tool writes is directly testable with `nginx -t -c <path>` (a snippet
 * meant only for inclusion from an existing http{} context, e.g. under
 * /etc/nginx/sites-available/, is not valid on its own and would fail
 * `nginx -t` regardless of whether the server block itself is correct).
 */
function generateConfig(serverName: string, options: GenerateNginxConfigOptions): string {
  return [
    "events {",
    "  worker_connections 1024;",
    "}",
    "",
    "http {",
    "  include       mime.types;",
    "  default_type  application/octet-stream;",
    "  sendfile      on;",
    "",
    serverBlock(serverName, options),
    "}",
    "",
  ].join("\n");
}

interface GenerateNginxConfigInput {
  serverName: string;
  outputPath: string;
  options?: GenerateNginxConfigOptions;
}

export const generateNginxConfigTool: ToolDefinition<GenerateNginxConfigInput> = {
  name: "generate_nginx_config",
  description:
    "Generate a real, syntactically correct, standalone nginx config file (events{} + http{} wrapping a " +
    "server{} block) for the given server name, at the given outputPath (required — this tool never assumes " +
    "/etc/nginx/... since writing there needs root it may not have; write into the project for review, or an " +
    "explicit system path if that's genuinely intended). With options.proxyPass (e.g. 'http://localhost:3000'), " +
    "generates a reverse-proxy location block with the standard proxy headers (Host, X-Real-IP, " +
    "X-Forwarded-For, X-Forwarded-Proto); without it, a static-file server block. With options.ssl, adds " +
    "listen 443 ssl and ssl_certificate/ssl_certificate_key directives (options.sslCertPath/sslKeyPath, " +
    "default /etc/nginx/ssl/fullchain.pem and privkey.pem). Does NOT reload or restart nginx — validate the " +
    "result with test_nginx_config, then apply/reload it yourself with whatever system access this tool " +
    "doesn't have.",
  riskLevel: "ask",
  riskKey: (input) => (isSystemNginxPath(input.outputPath) ? "generate_nginx_config:system-path" : "generate_nginx_config"),
  inputSchema: {
    type: "object",
    properties: {
      serverName: { type: "string", description: "server_name value, e.g. example.com" },
      outputPath: { type: "string", description: "Where to write the config (e.g. into the project for review — this tool does not assume /etc/nginx/...)" },
      options: {
        type: "object",
        properties: {
          proxyPass: { type: "string", description: "Upstream to reverse-proxy to, e.g. http://localhost:3000. Omit for a static-file server block." },
          ssl: { type: "boolean", description: "Generate an SSL (listen 443) server block with ssl_certificate/ssl_certificate_key directives" },
          sslCertPath: { type: "string", description: "ssl_certificate path (default /etc/nginx/ssl/fullchain.pem)" },
          sslKeyPath: { type: "string", description: "ssl_certificate_key path (default /etc/nginx/ssl/privkey.pem)" },
        },
      },
    },
    required: ["serverName", "outputPath"],
  },
  describeCall: (input) =>
    `generate nginx config for ${input.serverName} -> ${input.outputPath}${isSystemNginxPath(input.outputPath) ? " (system nginx path — implies actual deployment)" : ""}`,
  async handler(input, ctx) {
    const config = generateConfig(input.serverName, input.options ?? {});
    const filePath = resolveAllowedPath(ctx.cwd, input.outputPath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, config, "utf-8");
    return { content: `Wrote ${input.outputPath}:\n\n${config}`, isError: false };
  },
};

export interface TestNginxConfigOptions {
  nginxBinary?: string;
}

interface TestNginxConfigInput {
  configPath: string;
}

export function createTestNginxConfigTool(options: TestNginxConfigOptions = {}): ToolDefinition<TestNginxConfigInput> {
  const nginxBin = options.nginxBinary ?? "nginx";

  return {
    name: "test_nginx_config",
    description:
      "Validate an nginx config file's syntax with the real nginx binary (`nginx -t -c <configPath>` — `-t` " +
      "tests the configuration and exits, `-c` points it at this specific file instead of the system default). " +
      "Pure validation, no reload/restart of any running nginx — this tool never touches a live server.",
    riskLevel: "safe",
    riskKey: (input) => input.configPath,
    inputSchema: {
      type: "object",
      properties: {
        configPath: { type: "string", description: "Path to the nginx config file to validate" },
      },
      required: ["configPath"],
    },
    describeCall: (input) => `nginx -t -c ${input.configPath}`,
    async handler(input, ctx) {
      if (!isCommandAvailable(nginxBin)) {
        return { content: "nginx not available — install nginx (e.g. `brew install nginx` / `apt install nginx`) and ensure it's on PATH.", isError: true };
      }
      const filePath = resolveAllowedPath(ctx.cwd, input.configPath);
      return runSubprocess(nginxBin, {
        args: ["-t", "-c", filePath],
        cwd: ctx.cwd,
        sessionId: ctx.sessionId,
        timeoutMs: 30_000,
        signal: ctx.signal,
        format: "compact",
      });
    },
  };
}
