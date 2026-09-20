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

/** Thrown by connect() when allowOAuthPrompt is false and the server has no saved token yet, or by FileOAuthClientProvider.redirectToAuthorization when a *silent* provider hits a 401 mid-session — distinct from a real connection failure, so callers can report it separately (and without ever opening a browser). */
export class NeedsAuthorizationError extends Error {
  constructor(readonly serverName: string) {
    super(`MCP server "${serverName}" needs authorization — no saved token yet.`);
  }
}

// Every server uses the same fixed callback port (the redirect_uri is baked
// into each server's cached OAuth client registration at first connect, so
// changing it per-server would break already-registered connectors like a
// previously-authorized supabase/canva/notion). That means only one OAuth
// flow can be in flight at a time, process-wide — a real, reported bug:
// starting a second connector's authorization (e.g. Vercel) while a first
// one's 5-minute callback window was still open opened a second browser tab
// that could never be answered ("This site can't be reached" on the
// redirect back), since `waitForCallback()`'s http.createServer().listen()
// silently failed to (re)bind the already-in-use port. Tracked here so a
// second attempt fails fast with a clear message instead of opening a
// doomed browser tab.
let callbackServerActive = false;

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

  // Real, reported bug: a saved-but-expired token (Vercel issues no
  // refresh_token, so this happens routinely within an hour) let a browser
  // tab pop open completely unprompted, with no button ever clicked. The
  // MCP SDK calls its own internal auth() — which calls
  // redirectToAuthorization() below — on *any* 401 it sees, not just during
  // an explicit connect(): a tool call made minutes or hours into a normal
  // conversation, long after the server silently reconnected this client
  // at startup, hits this exact path with nobody watching for it.
  // McpClientManager flips this true right after a connection is
  // established (see connect()) regardless of how permissive that one
  // connect() attempt was, so only a fresh, explicit reconnect — which
  // builds a new provider — ever gets to open a browser again.
  private silent = false;

  constructor(private readonly serverName: string, port = DEFAULT_CALLBACK_PORT) {
    this.port = port;
  }

  setSilent(silent: boolean): void {
    this.silent = silent;
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
    if (this.silent) {
      throw new NeedsAuthorizationError(this.serverName);
    }
    if (callbackServerActive) {
      throw new Error(
        `Another connector's authorization is already in progress — finish that browser tab first, or wait up to 5 minutes for it to time out, then try "${this.serverName}" again.`,
      );
    }
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
      callbackServerActive = true;
      const finish = (fn: () => void) => {
        callbackServerActive = false;
        fn();
      };

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
        if (error) finish(() => reject(new Error(`OAuth authorization failed: ${error}`)));
        else if (code) finish(() => resolve(code));
        else finish(() => reject(new Error("OAuth callback received without an authorization code")));
      });

      // Real, reported bug: without this handler, a failure to bind
      // (e.g. EADDRINUSE from some unrelated process — the "another flow
      // already in progress" case is now caught earlier, in
      // redirectToAuthorization) surfaced as an unhandled 'error' event
      // instead of rejecting this promise, silently hanging the connect
      // attempt forever with the browser stuck on a dead callback URL.
      server.on("error", (err) => {
        clearTimeout(timer);
        finish(() => reject(new Error(`Couldn't start the local OAuth callback server on port ${this.port}: ${err.message}`)));
      });

      const timer = setTimeout(() => {
        server.close();
        finish(() => reject(new Error("Timed out waiting for OAuth authorization in the browser")));
      }, timeoutMs);

      server.listen(this.port);
    });
  }
}
