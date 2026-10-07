import { describe, expect, it } from "vitest";
import { highlightCode, resolveLanguage } from "../src/highlight";

describe("highlightCode", () => {
  it("colours a Dockerfile", () => {
    const { html, language } = highlightCode("FROM node:22-alpine\nRUN npm ci\nCMD [\"node\", \"index.js\"]", "dockerfile");
    expect(language).toBe("dockerfile");
    expect(html).toContain('class="hljs-keyword"');
  });

  it("knows the usual aliases", () => {
    expect(resolveLanguage("docker")).toBe("dockerfile");
    expect(resolveLanguage("yml")).toBe("yaml");
    expect(resolveLanguage("sh")).toBe("bash");
    expect(resolveLanguage("TSX")).toBe("typescript");
    expect(resolveLanguage("html title")).toBe("xml");
  });

  it("shows an unknown or missing language as escaped plain text, never as markup", () => {
    const { html, language } = highlightCode("<script>alert(1)</script> & more", "klingon");
    expect(language).toBeUndefined();
    expect(html).toBe("&lt;script&gt;alert(1)&lt;/script&gt; &amp; more");
    expect(highlightCode("a < b", undefined).html).toBe("a &lt; b");
  });

  it("never lets code through as live HTML even when it is highlighted", () => {
    expect(highlightCode('<img src=x onerror="alert(1)">', "html").html).not.toContain("<img");
  });
});
