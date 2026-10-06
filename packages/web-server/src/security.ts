import { realpath } from "node:fs/promises";
import path from "node:path";

// Guards for the HTTP/WebSocket surface. Kept free of server state so each rule is unit-testable.

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

/** True when `host` (the FINANFA_WEB_HOST bind address) only accepts connections from this machine. */
export function isLoopbackBind(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  return LOOPBACK_HOSTNAMES.has(h) || /^127\.\d+\.\d+\.\d+$/.test(h);
}

/** The hostname of a Host header, without port, lower-cased: "Localhost:4600" -> "localhost", "[::1]:4600" -> "::1". */
export function hostnameOf(hostHeader: string | undefined): string | undefined {
  if (!hostHeader) return undefined;
  try {
    return new URL(`http://${hostHeader}`).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return undefined;
  }
}

/** FINANFA_ALLOWED_ORIGINS: comma-separated origins (scheme://host[:port]); invalid entries are dropped. Returns normalized origins. */
export function parseAllowedOrigins(value: string | undefined): string[] {
  const origins: string[] = [];
  for (const part of (value ?? "").split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    try {
      origins.push(new URL(trimmed).origin);
    } catch {
      // not a URL — ignore rather than guess what was meant
    }
  }
  return origins;
}

export interface OriginPolicy {
  /** The server only listens on loopback, so a request must also address it by a loopback name (or an allowed one) — see checkRequestHost. */
  loopbackBound: boolean;
  /** Origins that may use the server from a browser besides its own (FINANFA_ALLOWED_ORIGINS). */
  allowedOrigins: string[];
  /** Further hostnames that legitimately reach this server, evaluated per request (e.g. the public tunnel's host, known only once it is up). */
  extraHostnames?: () => string[];
}

/**
 * DNS-rebinding guard. A server bound to loopback is only ever meant to be reached as localhost /
 * 127.0.0.1 / ::1; a page on attacker.example that rebinds its name to 127.0.0.1 arrives with
 * `Host: attacker.example`, and without this check would be same-origin with the whole API.
 * Non-loopback binds (a deployment behind a real domain) can't know their own name: they rely on auth.
 */
export function checkRequestHost(hostHeader: string | undefined, policy: OriginPolicy): boolean {
  if (!policy.loopbackBound) return true;
  const hostname = hostnameOf(hostHeader);
  if (!hostname) return false;
  if (LOOPBACK_HOSTNAMES.has(hostname)) return true;
  if (policy.allowedOrigins.some((o) => new URL(o).hostname.replace(/^\[|\]$/g, "") === hostname)) return true;
  return (policy.extraHostnames?.() ?? []).some((h) => h.toLowerCase() === hostname);
}

/**
 * Browsers always send Origin on a WebSocket handshake and let any page open one to any host, so
 * without this check a random web page could drive the agent. No Origin means a non-browser client
 * (the CLI, tests, curl): allowed, since it is not a cross-site attack vector. Otherwise the origin
 * must be this server's own (same host as the Host header) or explicitly allowed.
 */
export function checkWebSocketOrigin(origin: string | undefined, hostHeader: string | undefined, policy: OriginPolicy): boolean {
  if (origin === undefined) return true;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false; // "null" (sandboxed iframe, file://) and garbage
  }
  if (policy.allowedOrigins.includes(parsed.origin)) return true;
  return hostHeader !== undefined && parsed.host.toLowerCase() === hostHeader.toLowerCase();
}

// --- files served to the browser -------------------------------------------------------------

/** Directories and files that never leave the server through /api/workspace-file, even inside the project. */
const DENIED_SEGMENTS = new Set([".finanfa-code", ".git", ".ssh", ".gnupg", ".aws", ".kube", ".docker", ".npmrc", ".netrc"]);

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export class WorkspaceFileError extends Error {}

/**
 * Resolves a browser-supplied path to a real file INSIDE the project directory. Unlike the agent's own
 * file tools (which may touch the whole home directory, with a permission prompt), this endpoint is
 * unauthenticated by default and has no prompt, so it is confined to the project, follows symlinks
 * before checking (a link pointing out of the project is refused), and never serves credential
 * locations. The message is deliberately generic: it must not reveal what exists elsewhere on disk.
 */
export async function resolveWorkspaceFile(cwd: string, requested: string): Promise<string> {
  const refuse = () => new WorkspaceFileError("File not found or not accessible.");
  if (requested.includes("\0")) throw refuse();
  let root: string;
  let real: string;
  try {
    root = await realpath(cwd);
    real = await realpath(path.resolve(root, requested));
  } catch {
    throw refuse();
  }
  if (!isWithin(root, real)) throw refuse();
  const segments = path.relative(root, real).split(path.sep);
  if (segments.some((s) => DENIED_SEGMENTS.has(s) || s.startsWith(".env"))) throw refuse();
  return real;
}
