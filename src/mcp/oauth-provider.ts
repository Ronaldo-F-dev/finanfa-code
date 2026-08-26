import http from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { openUrl } from "../util/open-url.js";

const DEFAULT_CALLBACK_PORT = 51789;

function authDir(serverName: string): string {
  return path.join(os.homedir(), ".finanfa-code", "mcp-auth", serverName);
}

async function readJsonIfExists<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf-8")) as T;
  } catch {
    return undefined;
  }
}

async function writeJson(file: string, data: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(data, null, 2), "utf-8");
}

/**
 * A minimal, file-persisted OAuthClientProvider for remote (HTTP/SSE) MCP
 * servers: opens the authorization URL in the user's browser, receives the
 * redirect via a short-lived local HTTP server, and persists client
 * registration + tokens under ~/.finanfa-code/mcp-auth/<server-name>/ so
 * reconnecting later doesn't require re-authorizing.
 */
export class FileOAuthClientProvider implements OAuthClientProvider {
  private readonly port: number;
  private codeVerifierMemo: string | undefined;

  constructor(private readonly serverName: string, port = DEFAULT_CALLBACK_PORT) {
    this.port = port;
  }

  get redirectUrl(): string {
    return `http://127.0.0.1:${this.port}/callback`;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.redirectUrl],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: "finanfa-code",
      software_id: "finanfa-code",
    };
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    return readJsonIfExists(path.join(authDir(this.serverName), "client.json"));
  }

  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    await writeJson(path.join(authDir(this.serverName), "client.json"), info);
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return readJsonIfExists(path.join(authDir(this.serverName), "tokens.json"));
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await writeJson(path.join(authDir(this.serverName), "tokens.json"), tokens);
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.codeVerifierMemo = codeVerifier;
  }

  codeVerifier(): string {
    if (!this.codeVerifierMemo) {
      throw new Error("No PKCE code verifier available — did the authorization flow start?");
    }
    return this.codeVerifierMemo;
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    console.error(
      `\nOpen this URL to authorize finanfa-code for "${this.serverName}":\n${authorizationUrl.toString()}\n`,
    );
    openUrl(authorizationUrl.toString());
  }

  /**
   * Waits for the OAuth redirect via a short-lived local HTTP server on the
   * callback port. Call this after catching UnauthorizedError from a
   * transport's connect(), then pass the resolved code to the transport's
   * finishAuth(code) before retrying connect().
   */
  waitForCallback(timeoutMs = 5 * 60 * 1000): Promise<string> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        const url = new URL(req.url ?? "/", this.redirectUrl);
        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");

        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
          error
            ? `<p>Authorization failed: ${error}. You can close this tab and return to the terminal.</p>`
            : `<p>finanfa-code is now authorized. You can close this tab and return to the terminal.</p>`,
        );

        clearTimeout(timer);
        server.close();
        if (error) reject(new Error(`OAuth authorization failed: ${error}`));
        else if (code) resolve(code);
        else reject(new Error("OAuth callback received without an authorization code"));
      });

      const timer = setTimeout(() => {
        server.close();
        reject(new Error("Timed out waiting for OAuth authorization in the browser"));
      }, timeoutMs);

      server.listen(this.port);
    });
  }
}
