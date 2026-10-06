import { describe, expect, it } from "vitest";
import { isInternalUrl, isSafeExternalUrl } from "../src/navigation.js";

const origin = "http://127.0.0.1:51234";

describe("isInternalUrl", () => {
  it("accepts the server's own pages, any path", () => {
    expect(isInternalUrl("http://127.0.0.1:51234/", origin)).toBe(true);
    expect(isInternalUrl("http://127.0.0.1:51234/api/projects?x=1#y", origin)).toBe(true);
  });
  it("refuses another port, host, scheme, or garbage", () => {
    for (const u of ["http://127.0.0.1:9/", "http://localhost:51234/", "https://127.0.0.1:51234/", "https://evil.example/", "not a url", "file:///etc/passwd"]) {
      expect(isInternalUrl(u, origin), u).toBe(false);
    }
  });
});

describe("isSafeExternalUrl", () => {
  it("allows web and mail links", () => {
    for (const u of ["https://example.com/a?b=c", "http://example.com", "mailto:a@b.co"]) expect(isSafeExternalUrl(u), u).toBe(true);
  });
  it("drops everything that could run code or touch local files", () => {
    for (const u of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,<script>1</script>", "vscode://x", "ssh://host", "smb://host/share", "not a url", ""]) {
      expect(isSafeExternalUrl(u), u).toBe(false);
    }
  });
});
