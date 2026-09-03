import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AddressInfo } from "node:net";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

/**
 * A single static file server rooted at the project directory, started
 * lazily on first use and reused for the rest of the session — so a
 * previewed page's relative asset references (CSS/JS/images, fetch() calls)
 * actually resolve, unlike opening a bare `file://` URL, which breaks any
 * relative fetch()/module import and gives every previewed page its own
 * opaque origin.
 */
export class PreviewServer {
  private server: http.Server | undefined;
  private port: number | undefined;

  private async ensureStarted(root: string): Promise<number> {
    if (this.server && this.port) return this.port;

    this.server = http.createServer((req, res) => {
      void this.handleRequest(root, req, res);
    });
    await new Promise<void>((resolve) => this.server?.listen(0, "127.0.0.1", resolve));
    this.port = (this.server.address() as AddressInfo).port;
    this.server.unref(); // don't keep finanfa-code alive just because this is running
    return this.port;
  }

  private async handleRequest(root: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const urlPath = decodeURIComponent((req.url ?? "/").split("?")[0] ?? "/");
      const resolved = path.join(root, urlPath);
      // Path-traversal guard at the HTTP layer, separate from the tool's own
      // resolveAllowedPath check — a previewed page's own script could
      // otherwise fetch("../../../etc/passwd") and this server would serve
      // it, since the browser doesn't enforce the project-root boundary the
      // model's tool calls are held to.
      if (!resolved.startsWith(root)) {
        res.writeHead(403).end("Forbidden");
        return;
      }
      const data = await readFile(resolved);
      const ext = path.extname(resolved).toLowerCase();
      res.writeHead(200, { "Content-Type": MIME_TYPES[ext] ?? "application/octet-stream" });
      res.end(data);
    } catch {
      res.writeHead(404).end("Not found");
    }
  }

  /** The http://127.0.0.1:PORT/relative-path URL for a file, starting the server on first call. */
  async urlFor(root: string, relativePath: string): Promise<string> {
    const port = await this.ensureStarted(root);
    const urlPath = relativePath.split(path.sep).map(encodeURIComponent).join("/");
    return `http://127.0.0.1:${port}/${urlPath}`;
  }
}
