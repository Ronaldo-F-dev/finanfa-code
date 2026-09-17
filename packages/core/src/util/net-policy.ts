import dns from "node:dns/promises";
import net from "node:net";

// Real SSRF (server-side request forgery) hardening for outbound fetches
// the model can trigger with no human in the loop (web_fetch is
// riskLevel "safe") — a page's own content, or a search result, could
// otherwise steer the agent into fetching a cloud metadata endpoint
// (169.254.169.254), an internal admin panel, or a redirect chain that
// lands on one, and the response would come back looking like ordinary
// (if wrapped-as-untrusted) page content. Deliberately NOT applied to
// http_request — that tool is riskLevel "ask" (a human reviews every
// call) and its own documented purpose is testing a locally-running API,
// which legitimately targets 127.0.0.1/private addresses; blocking those
// there would break its actual job.
const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);
const MAX_REDIRECTS = 5;

function isPrivateOrReservedIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return false;
  const [a, b] = parts;
  if (a === 127) return true; // loopback
  if (a === 10) return true; // RFC1918 private
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918 private
  if (a === 192 && b === 168) return true; // RFC1918 private
  if (a === 169 && b === 254) return true; // link-local — includes the AWS/GCP/Azure cloud metadata endpoint
  if (a === 0) return true; // "this network"
  if (a >= 224) return true; // multicast/reserved
  return false;
}

function isPrivateOrReservedIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return true; // loopback / unspecified
  if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) return true; // fe80::/10 link-local
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // fc00::/7 unique local
  if (lower.startsWith("::ffff:")) return isPrivateOrReservedIPv4(lower.slice("::ffff:".length));
  return false;
}

export function isPrivateOrReservedIp(ip: string): boolean {
  return net.isIPv4(ip) ? isPrivateOrReservedIPv4(ip) : isPrivateOrReservedIPv6(ip);
}

export interface OutboundUrlCheck {
  ok: boolean;
  reason?: string;
}

async function defaultResolve(hostname: string): Promise<string[]> {
  const results = await dns.lookup(hostname, { all: true, verbatim: true });
  return results.map((r) => r.address);
}

/**
 * Validates a URL is safe to fetch: http/https only, no embedded
 * credentials, and — resolving DNS itself rather than trusting the
 * hostname string alone, since a hostname can resolve to a private
 * address just as easily as a literal IP can (DNS rebinding) — every
 * resolved address must be public/routable.
 */
export async function checkOutboundUrl(rawUrl: string, resolve: (hostname: string) => Promise<string[]> = defaultResolve): Promise<OutboundUrlCheck> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: `"${rawUrl}" is not a valid URL.` };
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    return { ok: false, reason: `Protocol "${url.protocol}" is not allowed here — only http/https.` };
  }
  if (url.username || url.password) {
    return { ok: false, reason: "URLs with embedded credentials (user:pass@host) are not allowed." };
  }

  const literalIp = net.isIP(url.hostname) ? url.hostname : undefined;
  let addresses: string[];
  try {
    addresses = literalIp ? [literalIp] : await resolve(url.hostname);
  } catch (err) {
    return { ok: false, reason: `Could not resolve host "${url.hostname}": ${err instanceof Error ? err.message : String(err)}` };
  }
  if (addresses.length === 0) {
    return { ok: false, reason: `Host "${url.hostname}" did not resolve to any address.` };
  }
  const blocked = addresses.find(isPrivateOrReservedIp);
  if (blocked) {
    return { ok: false, reason: `"${url.hostname}" resolves to ${blocked}, a private/internal address — blocked to prevent SSRF.` };
  }
  return { ok: true };
}

/**
 * `fetch`, but every hop (the initial URL, and every redirect it points
 * to in turn — a real, documented SSRF technique: an allowed public URL
 * whose server responds with a redirect to an internal one) is validated
 * with checkOutboundUrl before it's actually requested.
 */
export async function guardedFetch(url: string, init: RequestInit = {}, resolve?: (hostname: string) => Promise<string[]>): Promise<Response> {
  let currentUrl = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const check = await checkOutboundUrl(currentUrl, resolve);
    if (!check.ok) throw new Error(check.reason);

    const response = await fetch(currentUrl, { ...init, redirect: "manual" });
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      currentUrl = new URL(location, currentUrl).href;
      continue;
    }
    return response;
  }
  throw new Error(`Too many redirects (>${MAX_REDIRECTS}) fetching ${url}.`);
}
