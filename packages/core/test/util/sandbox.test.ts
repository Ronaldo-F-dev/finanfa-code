import { describe, expect, it, afterEach } from "vitest";
import { buildBwrapArgs, isBwrapAvailable, shouldSandbox, resetBwrapAvailabilityCacheForTests, DEFAULT_EXTRA_WRITABLE_PATHS } from "../../src/util/sandbox.js";

describe("sandbox.ts", () => {
  afterEach(() => {
    resetBwrapAvailabilityCacheForTests();
  });

  it("detects bwrap as available on this real Linux CI/dev machine", () => {
    expect(isBwrapAvailable()).toBe(true);
  });

  it("caches the availability check across calls", () => {
    const first = isBwrapAvailable();
    const second = isBwrapAvailable();
    expect(first).toBe(second);
  });

  it("buildBwrapArgs binds cwd read-write and roots the rest of the filesystem read-only", () => {
    const args = buildBwrapArgs("/some/project", []);
    expect(args).toContain("--ro-bind");
    expect(args.slice(args.indexOf("--ro-bind"), args.indexOf("--ro-bind") + 3)).toEqual(["--ro-bind", "/", "/"]);
    expect(args).toEqual(expect.arrayContaining(["--bind", "/some/project", "/some/project"]));
    expect(args).toEqual(expect.arrayContaining(["--bind", "/tmp", "/tmp"]));
    expect(args).toContain("--die-with-parent");
  });

  it("buildBwrapArgs adds --bind-try for each extra writable path", () => {
    const args = buildBwrapArgs("/proj", ["/extra/one", "/extra/two"]);
    expect(args.filter((a) => a === "--bind-try")).toHaveLength(2);
    expect(args).toEqual(expect.arrayContaining(["--bind-try", "/extra/one", "--bind-try", "/extra/two"]));
  });

  it("DEFAULT_EXTRA_WRITABLE_PATHS is non-empty and includes common dev-tool cache dirs", () => {
    expect(DEFAULT_EXTRA_WRITABLE_PATHS.length).toBeGreaterThan(0);
    expect(DEFAULT_EXTRA_WRITABLE_PATHS.some((p) => p.endsWith(".npm"))).toBe(true);
  });

  it("shouldSandbox is false for mode 'off' even when bwrap is available", () => {
    expect(shouldSandbox({ mode: "off" })).toBe(false);
  });

  it("shouldSandbox is false when no config is given", () => {
    expect(shouldSandbox(undefined)).toBe(false);
  });

  it("shouldSandbox is true for 'workspace-write' when bwrap is available", () => {
    expect(shouldSandbox({ mode: "workspace-write" })).toBe(true);
  });
});
