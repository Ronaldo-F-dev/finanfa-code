export type View = { kind: "chat" } | { kind: "projects" } | { kind: "project"; id: string };

/**
 * Real reported bug: nothing in App.tsx ever persisted which view/project/
 * session was open, so a genuine browser refresh (F5) reset every one of
 * these to their hardcoded defaults — landing back on a brand-new, empty
 * default-workspace chat, with no way to get back to the conversation that
 * was just on screen. Reading them from the URL on first mount (paired with
 * the effect in App.tsx that keeps the URL in sync as they change) means an
 * F5 — or a bookmark, or sharing the link — actually restores where you
 * were, instead of only ever working via in-app navigation.
 *
 * Pure functions taking `search` (e.g. window.location.search) as a plain
 * string rather than reading `window` themselves — keeps them trivially
 * unit-testable with no DOM/jsdom dependency, and there's exactly one real
 * caller (App.tsx) that has to thread the actual value through.
 */
export function readViewFromUrl(search: string): View {
  const params = new URLSearchParams(search);
  const kind = params.get("view");
  if (kind === "projects") return { kind: "projects" };
  const projectId = params.get("project");
  if (kind === "project" && projectId) return { kind: "project", id: projectId };
  return { kind: "chat" };
}

/** Only meaningful for the "chat" view — "project" (browsing a project's own page, not chatting yet) carries its id on the View itself, not here. */
export function readActiveProjectIdFromUrl(search: string): string | undefined {
  const params = new URLSearchParams(search);
  if (params.get("view") === "project") return undefined;
  return params.get("project") ?? undefined;
}

export function readActiveSessionIdFromUrl(search: string): string | undefined {
  return new URLSearchParams(search).get("session") ?? undefined;
}

/** Builds the `?view=...&project=...&session=...` query string App.tsx's own URL-sync effect writes back via history.replaceState — the exact inverse of the three readers above. */
export function buildUrlSearch(view: View, activeProjectId: string | undefined, sessionId: string | undefined): string {
  const params = new URLSearchParams();
  if (view.kind === "projects") {
    params.set("view", "projects");
  } else if (view.kind === "project") {
    params.set("view", "project");
    params.set("project", view.id);
  } else {
    if (activeProjectId) params.set("project", activeProjectId);
    if (sessionId) params.set("session", sessionId);
  }
  return params.toString();
}
