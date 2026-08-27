import { describe, expect, it } from "vitest";
import { BASE_SYSTEM_PROMPT, SECURITY_INSTRUCTION } from "../src/cli.js";

describe("system prompt: security instruction", () => {
  it("is present in the base system prompt sent to the model", () => {
    expect(BASE_SYSTEM_PROMPT).toContain(SECURITY_INSTRUCTION);
  });

  it("covers the key protections: authorized use, and refusing destructive/malicious use", () => {
    expect(SECURITY_INSTRUCTION).toMatch(/authorized security testing|defensive security/i);
    expect(SECURITY_INSTRUCTION).toMatch(/CTF/i);
    expect(SECURITY_INSTRUCTION).toMatch(/destructive/i);
    expect(SECURITY_INSTRUCTION).toMatch(/denial-of-service/i);
    expect(SECURITY_INSTRUCTION).toMatch(/supply-chain compromise/i);
    expect(SECURITY_INSTRUCTION).toMatch(/evading detection/i);
    expect(SECURITY_INSTRUCTION).toMatch(/authorization/i);
  });
});

describe("system prompt: path guidance", () => {
  it("tells the model to use absolute paths outside the project instead of relative traversal", () => {
    expect(BASE_SYSTEM_PROMPT).toMatch(/absolute path/i);
    expect(BASE_SYSTEM_PROMPT).toMatch(/relative.*"\.\.\/"|"\.\.\/".*relative/i);
  });

  it("warns against assuming a localized standard folder name", () => {
    expect(BASE_SYSTEM_PROMPT).toContain("Desktop");
    expect(BASE_SYSTEM_PROMPT).toContain("Bureau");
  });

  it("forbids guessing/hardcoding a username, and warns that '~' isn't expanded", () => {
    expect(BASE_SYSTEM_PROMPT).toMatch(/never guess or hardcode a username/i);
    expect(BASE_SYSTEM_PROMPT).toMatch(/not expanded/i);
  });

  it("says to flag a mismatched-locale project folder to the user instead of silently continuing in it", () => {
    expect(BASE_SYSTEM_PROMPT).toMatch(/leftover from a past mistake, not confirmation the name is right/i);
    expect(BASE_SYSTEM_PROMPT).toMatch(/point it out to the user and ask whether to keep it there or move it/i);
  });
});

describe("system prompt: server-readiness guidance", () => {
  it("tells the model to poll a server it just started instead of a fixed sleep", () => {
    expect(BASE_SYSTEM_PROMPT).toMatch(/poll for it instead of a fixed/i);
    expect(BASE_SYSTEM_PROMPT).toMatch(/looks exactly like a crash when it isn't/i);
  });
});

describe("system prompt: background process tools", () => {
  it("prefers start_background_process over manual bash backgrounding", () => {
    expect(BASE_SYSTEM_PROMPT).toMatch(/start_background_process/);
    expect(BASE_SYSTEM_PROMPT).toMatch(/not `bash \.\.\. &`\/`nohup`\/`setsid`/);
  });

  it("mentions list/stop by name instead of guessing pkill patterns", () => {
    expect(BASE_SYSTEM_PROMPT).toMatch(/list_background_processes/);
    expect(BASE_SYSTEM_PROMPT).toMatch(/stop_background_process/);
    expect(BASE_SYSTEM_PROMPT).toMatch(/guessing at `pkill -f/);
  });
});

describe("system prompt: document tools", () => {
  it("tells the model to use read_document instead of bash/read_file for binary document formats", () => {
    expect(BASE_SYSTEM_PROMPT).toMatch(/read_document/);
    expect(BASE_SYSTEM_PROMPT).toMatch(/not bash\/read_file/);
    expect(BASE_SYSTEM_PROMPT).toMatch(/Legacy \.xls isn't/);
  });

  it("says legacy .doc is supported (unlike .xls), via a different extractor than .docx", () => {
    expect(BASE_SYSTEM_PROMPT).toMatch(/legacy \.doc is, via a different extractor/);
  });

  it("mentions write_spreadsheet, edit_spreadsheet, and merge_spreadsheets", () => {
    expect(BASE_SYSTEM_PROMPT).toMatch(/write_spreadsheet/);
    expect(BASE_SYSTEM_PROMPT).toMatch(/edit_spreadsheet/);
    expect(BASE_SYSTEM_PROMPT).toMatch(/merge_spreadsheets/);
  });

  it("mentions merge_pdf and explains why there's no in-place PDF text editor", () => {
    expect(BASE_SYSTEM_PROMPT).toMatch(/merge_pdf/);
    expect(BASE_SYSTEM_PROMPT).toMatch(/no tool for editing existing PDF text in place/);
  });

  it("mentions write_document and edit_document, and warns about Word's multi-run splitting", () => {
    expect(BASE_SYSTEM_PROMPT).toMatch(/write_document/);
    expect(BASE_SYSTEM_PROMPT).toMatch(/edit_document/);
    expect(BASE_SYSTEM_PROMPT).toMatch(/splits a sentence across several runs/);
  });
});

describe("system prompt: GitHub issue-to-PR workflow", () => {
  it("prefers git_push over bash, and sequences the full issue-to-PR flow", () => {
    expect(BASE_SYSTEM_PROMPT).toMatch(/git_push/);
    expect(BASE_SYSTEM_PROMPT).toMatch(/mcp__github__issue_read/);
    expect(BASE_SYSTEM_PROMPT).toMatch(/mcp__github__create_pull_request/);
  });

  it("tells the model to treat pushing/opening a PR as real, visible actions worth checking on", () => {
    expect(BASE_SYSTEM_PROMPT).toMatch(/real, visible actions on a shared repo/i);
    expect(BASE_SYSTEM_PROMPT).toMatch(/check with the user before either/i);
  });
});
