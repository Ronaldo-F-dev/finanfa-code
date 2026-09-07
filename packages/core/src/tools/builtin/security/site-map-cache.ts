// A small in-memory, session-scoped cache that lets security_scan_crawler
// actually feed the single-URL tools automatically, instead of the caller
// having to copy-paste its output into each one by hand. This is the
// closest honest equivalent of cyberlens's own ScanContext (a single
// Python process holding ctx.discovered_forms/observed_get_requests for
// every scanner in the same run to read) that fits this project's
// architecture: each security_scan_* tool call is otherwise independent
// and stateless, but the tool registry — and this module-level cache —
// lives for the lifetime of the agent session, so a crawl earlier in the
// same conversation is still there when a later tool call needs it.
//
// Keyed by origin (protocol+host+port), not by exact URL, since a crawl
// starting from one page discovers forms/endpoints across the whole site.
// Intentionally NOT persisted to disk and NOT shared across sessions —
// scoped to this process's lifetime only, same as the rest of this
// project's in-memory state (e.g. BackgroundProcessManager).
export interface CachedForm {
  pageUrl: string;
  action: string;
  method: "get" | "post";
  fieldNames: string[];
  inferred: boolean;
}

interface SiteMapEntry {
  forms: CachedForm[];
  observedGetRequests: string[];
  recordedAt: number;
}

const cache = new Map<string, SiteMapEntry>();

function originKey(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

export function recordCrawl(targetUrl: string, data: { forms: CachedForm[]; observedGetRequests: string[] }): void {
  const key = originKey(targetUrl);
  if (!key) return;
  cache.set(key, { forms: data.forms, observedGetRequests: data.observedGetRequests, recordedAt: Date.now() });
}

export function getObservedGetRequests(targetUrl: string): string[] {
  const key = originKey(targetUrl);
  if (!key) return [];
  return cache.get(key)?.observedGetRequests ?? [];
}

export function getDiscoveredForms(targetUrl: string): CachedForm[] {
  const key = originKey(targetUrl);
  if (!key) return [];
  return cache.get(key)?.forms ?? [];
}

/** Finds a previously-crawled form matching both the page it was found on and its submission target — used to auto-fill fieldNames when a caller didn't supply them. */
export function findDiscoveredForm(pageUrl: string, formAction: string): CachedForm | undefined {
  return getDiscoveredForms(pageUrl).find((f) => f.pageUrl === pageUrl && f.action === formAction);
}

/** Test-only: clears every cached entry so tests don't leak state into each other. */
export function clearSiteMapCacheForTests(): void {
  cache.clear();
}
