import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { DEFAULT_PROJECT_ID, deleteProject, isValidProjectId, projectExists, resolveProjectDir } from "../src/projects.js";

const TRAVERSAL_IDS = ["../../..", "..", "../", "../../etc", "a/../..", "%2e%2e%2f", "/etc", "C:\\Windows", "default/..", "", " ", "0".repeat(36), `${randomUUID()}/..`, `${randomUUID()}\0`];

describe("project ids", () => {
  it("accept only 'default' and minted UUIDs", () => {
    expect(isValidProjectId(DEFAULT_PROJECT_ID)).toBe(true);
    expect(isValidProjectId(randomUUID())).toBe(true);
    for (const id of TRAVERSAL_IDS) expect(isValidProjectId(id), JSON.stringify(id)).toBe(false);
  });

  it("projectExists never says yes to a traversal id, even though such a directory exists", async () => {
    for (const id of TRAVERSAL_IDS) expect(await projectExists(id), JSON.stringify(id)).toBe(false);
  });

  it("resolveProjectDir refuses to build a path from a traversal id", () => {
    for (const id of TRAVERSAL_IDS.filter((i) => i !== "")) expect(() => resolveProjectDir(id, "/work"), JSON.stringify(id)).toThrow("Invalid project id.");
    expect(resolveProjectDir(DEFAULT_PROJECT_ID, "/work")).toBe("/work");
  });

  it("deleteProject refuses traversal ids", async () => {
    await expect(deleteProject("../..")).rejects.toThrow("Invalid project id.");
  });
});
