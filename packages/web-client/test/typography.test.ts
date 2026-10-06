import { describe, expect, it } from "vitest";
import { stripEmDashes } from "../src/typography";

describe("stripEmDashes", () => {
  it("turns a spaced dash into a comma and a bare one into a hyphen", () => {
    expect(stripEmDashes("Bonjour — voici la suite")).toBe("Bonjour, voici la suite");
    expect(stripEmDashes("2020—2024")).toBe("2020-2024");
  });
  it("leaves code alone, fenced (even unfinished) or inline", () => {
    expect(stripEmDashes("a `x — y` b — c")).toBe("a `x — y` b, c");
    expect(stripEmDashes("```\nx — y\n```\nok — fin")).toBe("```\nx — y\n```\nok, fin");
    expect(stripEmDashes("avant — ```\nx — y")).toBe("avant, ```\nx — y");
  });
  it("returns text without a dash untouched", () => {
    expect(stripEmDashes("rien à changer")).toBe("rien à changer");
  });
});
