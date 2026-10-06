import { describe, expect, it } from "vitest";
import { parseHookVerdict } from "../../src/hooks/verdict.js";

describe("parseHookVerdict", () => {
  it("reads a bare JSON verdict", () => {
    expect(parseHookVerdict('{"ok": true}')).toEqual({ ok: true, reason: undefined });
    expect(parseHookVerdict('{"ok": false, "reason": "tests are missing"}')).toEqual({ ok: false, reason: "tests are missing" });
  });

  it("finds the verdict inside prose or a code fence", () => {
    expect(parseHookVerdict('Checked the diff.\n```json\n{"ok": false, "reason": "no test"}\n```\nDone.')).toEqual({ ok: false, reason: "no test" });
  });

  it("takes the LAST verdict, not an example the model quoted earlier", () => {
    const text = 'I will answer like {"ok": true} if fine. Final answer: {"ok": false, "reason": "it is not fine"}';
    expect(parseHookVerdict(text)).toEqual({ ok: false, reason: "it is not fine" });
  });

  it("ignores objects without a boolean ok, and malformed JSON", () => {
    expect(parseHookVerdict('{"decision": "approve"}')).toBeUndefined();
    expect(parseHookVerdict('{"ok": "yes"}')).toBeUndefined();
    expect(parseHookVerdict('{"ok": true')).toBeUndefined();
    expect(parseHookVerdict("no json at all")).toBeUndefined();
    expect(parseHookVerdict("")).toBeUndefined();
  });

  it("copes with a reason that contains braces", () => {
    expect(parseHookVerdict('{"ok": false, "reason": "uses {placeholder} syntax"}')).toEqual({ ok: false, reason: "uses {placeholder} syntax" });
  });
});
