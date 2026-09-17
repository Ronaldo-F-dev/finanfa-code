import { describe, expect, it, vi, afterEach } from "vitest";
import { isPrivateOrReservedIp, checkOutboundUrl, guardedFetch } from "../../src/util/net-policy.js";

describe("isPrivateOrReservedIp", () => {
  it("flags loopback, RFC1918, and link-local (incl. cloud metadata) IPv4 addresses", () => {
    expect(isPrivateOrReservedIp("127.0.0.1")).toBe(true);
    expect(isPrivateOrReservedIp("10.0.0.5")).toBe(true);
    expect(isPrivateOrReservedIp("172.16.0.1")).toBe(true);
    expect(isPrivateOrReservedIp("172.31.255.255")).toBe(true);
    expect(isPrivateOrReservedIp("192.168.1.1")).toBe(true);
    expect(isPrivateOrReservedIp("169.254.169.254")).toBe(true); // AWS/GCP/Azure metadata endpoint
  });

  it("does not flag ordinary public IPv4 addresses", () => {
    expect(isPrivateOrReservedIp("8.8.8.8")).toBe(false);
    expect(isPrivateOrReservedIp("172.15.0.1")).toBe(false); // just outside the 172.16-31 private range
    expect(isPrivateOrReservedIp("172.32.0.1")).toBe(false);
  });

  it("flags loopback, link-local, and unique-local IPv6 addresses", () => {
    expect(isPrivateOrReservedIp("::1")).toBe(true);
    expect(isPrivateOrReservedIp("fe80::1")).toBe(true);
    expect(isPrivateOrReservedIp("fd00::1")).toBe(true);
    expect(isPrivateOrReservedIp("::ffff:127.0.0.1")).toBe(true); // IPv4-mapped
  });

  it("does not flag an ordinary public IPv6 address", () => {
    expect(isPrivateOrReservedIp("2606:4700:4700::1111")).toBe(false);
  });
});

describe("checkOutboundUrl", () => {
  it("rejects a non-http(s) protocol", async () => {
    const result = await checkOutboundUrl("file:///etc/passwd");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("file:");
  });

  it("rejects a malformed URL instead of throwing", async () => {
    const result = await checkOutboundUrl("not a url");
    expect(result.ok).toBe(false);
  });

  it("rejects a URL with embedded credentials", async () => {
    const result = await checkOutboundUrl("https://user:pass@example.com");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("credentials");
  });

  it("rejects a hostname that resolves to a private address (DNS rebinding-safe — checks the resolved IP, not the hostname string)", async () => {
    const result = await checkOutboundUrl("https://internal.example.com", async () => ["10.0.0.5"]);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("10.0.0.5");
  });

  it("rejects a literal private IP given directly as the hostname", async () => {
    const result = await checkOutboundUrl("http://169.254.169.254/latest/meta-data/");
    expect(result.ok).toBe(false);
  });

  it("allows a hostname that resolves only to public addresses", async () => {
    const result = await checkOutboundUrl("https://example.com", async () => ["93.184.216.34"]);
    expect(result.ok).toBe(true);
  });

  it("reports a clear error when DNS resolution itself fails, instead of throwing", async () => {
    const result = await checkOutboundUrl("https://nonexistent.invalid", async () => {
      throw new Error("ENOTFOUND");
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("ENOTFOUND");
  });
});

describe("guardedFetch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the response directly when there's no redirect", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("ok", { status: 200 })));
    const response = await guardedFetch("https://example.com", {}, async () => ["93.184.216.34"]);
    expect(response.status).toBe(200);
  });

  it("follows a redirect chain, re-validating every hop", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "https://example.com/final" } }))
      .mockResolvedValueOnce(new Response("final content", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await guardedFetch("https://example.com/start", {}, async () => ["93.184.216.34"]);
    expect(await response.text()).toBe("final content");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("blocks a redirect that points at a private address, even though the original URL was allowed", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(guardedFetch("https://example.com/start", {}, async () => ["93.184.216.34"])).rejects.toThrow(/private\/internal/);
    expect(fetchMock).toHaveBeenCalledTimes(1); // never actually requested the blocked redirect target
  });

  it("gives up after too many redirects instead of looping forever", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location: "https://example.com/next" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(guardedFetch("https://example.com/start", {}, async () => ["93.184.216.34"])).rejects.toThrow(/too many redirects/i);
  });
});
