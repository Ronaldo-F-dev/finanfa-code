import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveTrust } from "../../src/core/trust-gate.js";
import { isFolderTrusted } from "../../src/core/trust.js";
import type { UIAdapter } from "../../src/ui/adapter.js";

function makeUi(answer: string): UIAdapter {
  return {
    writeAssistantDelta: vi.fn(),
    endAssistantMessage: vi.fn(),
    writeBanner: vi.fn(),
    writeSystem: vi.fn(),
    writeError: vi.fn(),
    setStatus: vi.fn(),
    getStatus: vi.fn().mockReturnValue(undefined),
    setCommands: vi.fn(),
    setBusy: vi.fn(),
    askUser: vi.fn().mockResolvedValue(answer),
    close: vi.fn(),
  };
}

describe("core/trust-gate (real filesystem, real project directories)", () => {
  let homeDir: string;
  let projectDir: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    homeDir = await mkdtemp(path.join(tmpdir(), "finanfa-trustgate-home-"));
    projectDir = await mkdtemp(path.join(tmpdir(), "finanfa-trustgate-project-"));
    originalHome = process.env.HOME;
    process.env.HOME = homeDir;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(homeDir, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  });

  it("never prompts when the project has no .finanfa-code/settings.json or plugins directory", async () => {
    const ui = makeUi("y");
    const trusted = await resolveTrust(projectDir, ui);
    expect(trusted).toBe(true);
    expect(ui.askUser).not.toHaveBeenCalled();
  });

  it("prompts when the project has a plugins directory, even with no settings.json", async () => {
    await mkdir(path.join(projectDir, ".finanfa-code", "plugins", "greet"), { recursive: true });

    const ui = makeUi("n");
    const trusted = await resolveTrust(projectDir, ui);
    expect(trusted).toBe(false);
    expect(ui.askUser).toHaveBeenCalledTimes(1);
  });

  it("prompts and trusts (persisting it) when the user answers yes", async () => {
    await mkdir(path.join(projectDir, ".finanfa-code"), { recursive: true });
    await writeFile(path.join(projectDir, ".finanfa-code", "settings.json"), "{}");

    const ui = makeUi("y");
    const trusted = await resolveTrust(projectDir, ui);
    expect(trusted).toBe(true);
    expect(ui.askUser).toHaveBeenCalledTimes(1);
    expect(await isFolderTrusted(projectDir)).toBe(true);
  });

  it("prompts and does not trust (and does not persist) when the user answers no", async () => {
    await mkdir(path.join(projectDir, ".finanfa-code"), { recursive: true });
    await writeFile(path.join(projectDir, ".finanfa-code", "settings.json"), "{}");

    const ui = makeUi("n");
    const trusted = await resolveTrust(projectDir, ui);
    expect(trusted).toBe(false);
    expect(await isFolderTrusted(projectDir)).toBe(false);
    expect(ui.writeError).toHaveBeenCalledWith(expect.stringContaining("will be ignored"));
  });

  it("does not prompt again once a folder is already trusted", async () => {
    await mkdir(path.join(projectDir, ".finanfa-code"), { recursive: true });
    await writeFile(path.join(projectDir, ".finanfa-code", "settings.json"), "{}");

    const firstUi = makeUi("y");
    await resolveTrust(projectDir, firstUi);

    const secondUi = makeUi("n"); // would be denied if actually asked again
    const trusted = await resolveTrust(projectDir, secondUi);
    expect(trusted).toBe(true);
    expect(secondUi.askUser).not.toHaveBeenCalled();
  });

  it("fails closed without prompting when nonInteractive is set", async () => {
    await mkdir(path.join(projectDir, ".finanfa-code"), { recursive: true });
    await writeFile(path.join(projectDir, ".finanfa-code", "settings.json"), "{}");

    const ui = makeUi("y"); // would trust if actually asked
    const trusted = await resolveTrust(projectDir, ui, true);
    expect(trusted).toBe(false);
    expect(ui.askUser).not.toHaveBeenCalled();
    expect(await isFolderTrusted(projectDir)).toBe(false);
  });
});
