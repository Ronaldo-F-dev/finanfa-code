import { describe, expect, it } from "vitest";
import { scoreFromVector, severityFromScore } from "../../../src/tools/builtin/security/cvss.js";

describe("CVSS v3.1 base score calculator (ported from cyberlens/core/cvss.py)", () => {
  it("scores a well-known critical vector (10.0 — AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H)", () => {
    expect(scoreFromVector("AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H")).toBe(10.0);
  });

  it("scores a well-known 9.8 vector (AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H)", () => {
    expect(scoreFromVector("AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H")).toBe(9.8);
  });

  it("returns 0 for a vector with no impact at all", () => {
    expect(scoreFromVector("AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:N")).toBe(0);
  });

  it("throws on a malformed vector", () => {
    expect(() => scoreFromVector("not a vector")).toThrow(/Invalid CVSS/);
  });

  it("maps scores to the correct qualitative severity bands", () => {
    expect(severityFromScore(0)).toBe("INFO");
    expect(severityFromScore(3.9)).toBe("LOW");
    expect(severityFromScore(6.9)).toBe("MEDIUM");
    expect(severityFromScore(8.9)).toBe("HIGH");
    expect(severityFromScore(9.0)).toBe("CRITICAL");
    expect(severityFromScore(10)).toBe("CRITICAL");
  });
});
