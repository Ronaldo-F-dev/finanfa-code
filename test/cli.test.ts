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

describe("system prompt: UI/design visual verification loop", () => {
  it("tells the model to actually screenshot a mockup and check it, not assume the HTML/CSS is correct", () => {
    expect(BASE_SYSTEM_PROMPT).toMatch(/browser_navigate to.*that URL and browser_screenshot it/i);
    expect(BASE_SYSTEM_PROMPT).toMatch(/actually look at the rendered result before calling it done/i);
    expect(BASE_SYSTEM_PROMPT).toMatch(/don't assume\s*\n?\s*HTML\/CSS is right just because it wrote without error/i);
  });

  it("frames it as the same loop as run_tests: fix and re-screenshot until it matches", () => {
    expect(BASE_SYSTEM_PROMPT).toMatch(/re-screenshot; repeat until it matches what was asked/i);
    expect(BASE_SYSTEM_PROMPT).toMatch(/same as the\s*\n?\s*test\/fix loop below/i);
  });
});

describe("system prompt: create_artifact (React component) guidance", () => {
  it("tells the model to use create_artifact instead of hand-writing the React/Babel CDN boilerplate", () => {
    expect(BASE_SYSTEM_PROMPT).toMatch(/create_artifact instead of hand-writing the CDN script tags\/Babel boilerplate/i);
    expect(BASE_SYSTEM_PROMPT).toMatch(/component named App/i);
  });

  it("says the same screenshot-and-fix loop still applies to artifacts", () => {
    expect(BASE_SYSTEM_PROMPT).toMatch(/same screenshot-and-fix loop applies before handing it back/i);
  });

  it("mentions Tailwind CSS is available and treats visual polish as part of correctness", () => {
    expect(BASE_SYSTEM_PROMPT).toMatch(/Tailwind CSS included, use its utility classes/i);
    expect(BASE_SYSTEM_PROMPT).toMatch(/visual polish as part of correctness/i);
    expect(BASE_SYSTEM_PROMPT).toMatch(/never a bare unstyled page/i);
  });
});

describe("system prompt: server-readiness guidance", () => {
  it("tells the model to use wait_for_port instead of a fixed sleep or a hand-rolled bash loop", () => {
    expect(BASE_SYSTEM_PROMPT).toMatch(/use wait_for_port instead of a fixed/i);
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

  it("tells the model to use read_notebook/edit_notebook for Jupyter .ipynb files", () => {
    expect(BASE_SYSTEM_PROMPT).toMatch(/read_notebook/);
    expect(BASE_SYSTEM_PROMPT).toMatch(/edit_notebook/);
    expect(BASE_SYSTEM_PROMPT).toMatch(/0-based index/);
  });

  it("tells the model to use check_python_types for Python type-checking via Pyright", () => {
    expect(BASE_SYSTEM_PROMPT).toMatch(/check_python_types/);
    expect(BASE_SYSTEM_PROMPT).toMatch(/Pyright/);
  });

  it("tells the model resize_image's default fit doesn't crop, and warns it overwrites without outputPath", () => {
    expect(BASE_SYSTEM_PROMPT).toMatch(/resize_image/);
    expect(BASE_SYSTEM_PROMPT).toMatch(/scales to fit within that box without cropping/);
    expect(BASE_SYSTEM_PROMPT).toMatch(/Without outputPath it overwrites the original file/);
  });

  it("tells the model python_repl persists state across calls, unlike bash: python3 -c", () => {
    expect(BASE_SYSTEM_PROMPT).toMatch(/python_repl/);
    expect(BASE_SYSTEM_PROMPT).toMatch(/starts a fresh interpreter every call/);
    expect(BASE_SYSTEM_PROMPT).toMatch(/input\(\) will hang/);
  });

  it("tells the model query_database works against any language/framework's database, and warns about non-portable placeholders", () => {
    expect(BASE_SYSTEM_PROMPT).toMatch(/query_database/);
    expect(BASE_SYSTEM_PROMPT).toMatch(/regardless of what language\/framework/);
    expect(BASE_SYSTEM_PROMPT).toMatch(/does not persist between calls/);
  });

  it("tells the model to use http_request (not web_fetch) for testing an API endpoint", () => {
    expect(BASE_SYSTEM_PROMPT).toMatch(/http_request/);
    expect(BASE_SYSTEM_PROMPT).toMatch(/web_fetch is GET-only/);
  });

  it("tells the model lint_javascript needs an existing ESLint config and won't create one unasked", () => {
    expect(BASE_SYSTEM_PROMPT).toMatch(/lint_javascript/);
    expect(BASE_SYSTEM_PROMPT).toMatch(/refuses to run at all without one/);
    expect(BASE_SYSTEM_PROMPT).toMatch(/don't try to work around that by creating one yourself unless asked/);
  });

  it("tells the model check_typescript_types is always whole-project", () => {
    expect(BASE_SYSTEM_PROMPT).toMatch(/check_typescript_types/);
    expect(BASE_SYSTEM_PROMPT).toMatch(/always whole-project/);
  });

  it("tells the model lint_python needs uvx/ruff and not to self-install one", () => {
    expect(BASE_SYSTEM_PROMPT).toMatch(/lint_python/);
    expect(BASE_SYSTEM_PROMPT).toMatch(/tell the user rather than trying to install one yourself/);
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
