import { describe, expect, it } from "vitest";
import { readViewFromUrl, readActiveProjectIdFromUrl, readActiveSessionIdFromUrl, buildUrlSearch } from "../src/urlState";

// Real reported bug: App.tsx never persisted the current view/project/
// session anywhere (no URL, no localStorage) — a genuine browser refresh
// (F5) reset all three to their hardcoded defaults, landing on a brand-new
// empty chat and losing the conversation that was on screen. These pure
// functions (taking `search` as a plain string, not reading `window`
// themselves) are what App.tsx now uses to seed its initial state from the
// URL and to write it back — tested directly here, with no DOM/jsdom
// dependency needed at all.
describe("urlState: readViewFromUrl", () => {
  it("defaults to chat with no query string at all", () => {
    expect(readViewFromUrl("")).toEqual({ kind: "chat" });
  });

  it("reads the projects list view", () => {
    expect(readViewFromUrl("?view=projects")).toEqual({ kind: "projects" });
  });

  it("reads a project detail view with its id", () => {
    expect(readViewFromUrl("?view=project&project=abc-123")).toEqual({ kind: "project", id: "abc-123" });
  });

  it("falls back to chat for view=project with no project id — not a crash on a malformed/stale link", () => {
    expect(readViewFromUrl("?view=project")).toEqual({ kind: "chat" });
  });

  it("reads chat explicitly (also the default for any other/unknown view value)", () => {
    expect(readViewFromUrl("?view=chat&project=p1&session=s1")).toEqual({ kind: "chat" });
    expect(readViewFromUrl("?view=something-unexpected")).toEqual({ kind: "chat" });
  });
});

describe("urlState: readActiveProjectIdFromUrl", () => {
  it("reads a project id for the chat view", () => {
    expect(readActiveProjectIdFromUrl("?project=p1")).toBe("p1");
  });

  it("is undefined with no project param", () => {
    expect(readActiveProjectIdFromUrl("")).toBeUndefined();
  });

  it("is undefined for view=project — that project id belongs to the View itself, not the active chat project", () => {
    expect(readActiveProjectIdFromUrl("?view=project&project=p1")).toBeUndefined();
  });
});

describe("urlState: readActiveSessionIdFromUrl", () => {
  it("reads a session id", () => {
    expect(readActiveSessionIdFromUrl("?session=s1")).toBe("s1");
  });

  it("is undefined with no session param", () => {
    expect(readActiveSessionIdFromUrl("")).toBeUndefined();
  });
});

describe("urlState: buildUrlSearch (the exact inverse the URL-sync effect in App.tsx relies on)", () => {
  it("round-trips a plain default-workspace chat with a session", () => {
    const qs = buildUrlSearch({ kind: "chat" }, undefined, "s1");
    expect(readActiveProjectIdFromUrl(`?${qs}`)).toBeUndefined();
    expect(readActiveSessionIdFromUrl(`?${qs}`)).toBe("s1");
    expect(readViewFromUrl(`?${qs}`)).toEqual({ kind: "chat" });
  });

  it("round-trips a chat inside a project", () => {
    const qs = buildUrlSearch({ kind: "chat" }, "p1", "s1");
    expect(readViewFromUrl(`?${qs}`)).toEqual({ kind: "chat" });
    expect(readActiveProjectIdFromUrl(`?${qs}`)).toBe("p1");
    expect(readActiveSessionIdFromUrl(`?${qs}`)).toBe("s1");
  });

  it("round-trips a brand-new chat with no session yet (nothing set)", () => {
    expect(buildUrlSearch({ kind: "chat" }, undefined, undefined)).toBe("");
  });

  it("round-trips the projects list view", () => {
    const qs = buildUrlSearch({ kind: "projects" }, "ignored", "ignored");
    expect(readViewFromUrl(`?${qs}`)).toEqual({ kind: "projects" });
  });

  it("round-trips a project detail view, ignoring any stray session id", () => {
    const qs = buildUrlSearch({ kind: "project", id: "p1" }, undefined, "s1");
    expect(readViewFromUrl(`?${qs}`)).toEqual({ kind: "project", id: "p1" });
    expect(readActiveSessionIdFromUrl(`?${qs}`)).toBeUndefined();
  });
});
