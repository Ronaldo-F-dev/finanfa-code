import { describe, expect, it } from "vitest";
import { parseApiKeys } from "../src/app.js";

describe("parseApiKeys (FINANFA_API_KEYS parsing)", () => {
  it("splits a comma-separated list", () => {
    expect(parseApiKeys("key1,key2,key3")).toEqual(["key1", "key2", "key3"]);
  });

  it("splits a newline-separated list, trimming whitespace", () => {
    expect(parseApiKeys("key1\n key2 \nkey3")).toEqual(["key1", "key2", "key3"]);
  });

  it("returns undefined for unset/empty input, not an empty array — so it doesn't shadow config.apiKeys", () => {
    expect(parseApiKeys(undefined)).toBeUndefined();
    expect(parseApiKeys("")).toBeUndefined();
    expect(parseApiKeys("  ,  ,\n")).toBeUndefined();
  });

  it("drops empty entries from stray extra separators", () => {
    expect(parseApiKeys("key1,,key2,")).toEqual(["key1", "key2"]);
  });
});
