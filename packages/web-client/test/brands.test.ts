import { describe, expect, it } from "vitest";
import { readableTextOn, resolveBrand } from "../src/brands";

describe("resolveBrand", () => {
  it("gives a known service its real name, colour and mark", () => {
    const notion = resolveBrand("notion");
    expect(notion).toMatchObject({ label: "Notion", known: true });
    expect(notion.path).toMatch(/^M/); // an SVG path
    expect(resolveBrand("supabase").color).toBe("3FCF8E");
  });

  it("keeps the proper casing of brands whose name isn't just capitalised", () => {
    expect(resolveBrand("github").label).toBe("GitHub");
    expect(resolveBrand("line").label).toBe("LINE");
    expect(resolveBrand("drive").label).toBe("Google Drive");
  });

  it("maps a service's sub-connectors to the family's mark while saying which part they are", () => {
    const hosting = resolveBrand("hostinger-hosting");
    expect(hosting.known).toBe(true);
    expect(hosting.path).toBe(resolveBrand("hostinger").path);
    expect(hosting.label).toBe("Hostinger hosting");
    expect(resolveBrand("hostinger-dns").label).toBe("Hostinger dns");
  });

  it("gives brands without a bundled mark a coloured tile with initials", () => {
    for (const id of ["canva", "slack", "teams", "microsoft-365", "feishu", "twilio", "gamma"]) {
      const brand = resolveBrand(id);
      expect(brand.known, id).toBe(true);
      expect(brand.path, id).toBeUndefined();
      expect(brand.color, id).toMatch(/^[0-9A-F]{6}$/);
    }
    expect(resolveBrand("microsoft-365")).toMatchObject({ label: "Microsoft 365", initials: "M3" });
    expect(resolveBrand("canva").initials).toBe("C");
    expect(resolveBrand("slack").initials).toBe("S"); // not "Sl", which reads as "SI"
  });

  it("treats an unknown connector as a neutral tile, with a readable name", () => {
    expect(resolveBrand("my-internal-tool")).toMatchObject({ known: false, label: "My internal tool", color: "6E6E73", initials: "MI" });
    expect(resolveBrand("acme")).toMatchObject({ known: false, label: "Acme", initials: "A" });
  });

  it("is case-insensitive on the id", () => {
    expect(resolveBrand("Notion").known).toBe(true);
  });
});

describe("readableTextOn", () => {
  it("uses dark text on light colours and white on dark ones", () => {
    expect(readableTextOn("FFFFFF")).toBe("#111");
    expect(readableTextOn("00C4CC")).toBe("#111"); // Canva teal is light enough
    expect(readableTextOn("4A154B")).toBe("#fff"); // Slack aubergine
    expect(readableTextOn("000000")).toBe("#fff");
  });
});

import { tileColors } from "../src/brands";

describe("tileColors", () => {
  it("draws a brand on its own colour, with a mark readable on it", () => {
    expect(tileColors("5865F2")).toEqual({ background: "#5865F2", color: "#fff" }); // Discord blurple
    expect(tileColors("25D366")).toEqual({ background: "#25D366", color: "#111" }); // WhatsApp green is light
  });

  it("puts brands whose colour is black on a light tile, so they don't vanish on the dark theme", () => {
    expect(tileColors("000000")).toEqual({ background: "#f4f4f5", color: "#111" });
    expect(tileColors("191919").background).toBe("#f4f4f5");
  });
});
