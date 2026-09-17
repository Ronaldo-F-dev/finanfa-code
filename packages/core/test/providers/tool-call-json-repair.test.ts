import { describe, expect, it } from "vitest";
import { repairTruncatedToolCallJson } from "../../src/providers/tool-call-json-repair.js";

describe("repairTruncatedToolCallJson", () => {
  it("closes a truncated top-level object", () => {
    expect(repairTruncatedToolCallJson('{"path":"a.txt"')).toEqual({ path: "a.txt" });
  });

  it("closes a truncated nested object/array", () => {
    expect(repairTruncatedToolCallJson('{"files":["a.txt","b.txt"')).toEqual({ files: ["a.txt", "b.txt"] });
  });

  it("closes a stream cut off mid-string value", () => {
    expect(repairTruncatedToolCallJson('{"content":"line one\\nline two')).toEqual({ content: "line one\nline two" });
  });

  it("closes a stream cut off right after a trailing comma, stripping it", () => {
    expect(repairTruncatedToolCallJson('{"a":1,')).toEqual({ a: 1 });
  });

  it("closes deeply nested truncation (object containing an array containing an object)", () => {
    expect(repairTruncatedToolCallJson('{"outer":{"items":[{"id":1')).toEqual({ outer: { items: [{ id: 1 }] } });
  });

  it("returns undefined for already-valid JSON — nothing to repair", () => {
    expect(repairTruncatedToolCallJson('{"path":"a.txt"}')).toBeUndefined();
  });

  it("returns undefined for empty input", () => {
    expect(repairTruncatedToolCallJson("")).toBeUndefined();
  });

  it("returns undefined for a genuine mismatch, not a truncation (extra closing bracket)", () => {
    expect(repairTruncatedToolCallJson('{"a":1}]')).toBeUndefined();
  });

  it("returns undefined for a real syntax error unrelated to truncation (unescaped control character breaks the string, but nesting is otherwise closed)", () => {
    // A literal (unescaped) newline inside a JSON string is invalid JSON,
    // but the braces/quotes ARE balanced — not something this narrow
    // truncation-only repair should paper over.
    const withRawNewline = '{"content":"line one\nline two"}';
    expect(repairTruncatedToolCallJson(withRawNewline)).toBeUndefined();
  });

  it("does not get confused by braces/brackets that appear inside string values", () => {
    expect(repairTruncatedToolCallJson('{"code":"if (x) { return [1,2]; }')).toEqual({ code: "if (x) { return [1,2]; }" });
  });
});
