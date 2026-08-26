import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// node:readline/promises' createInterface pulls in real stdin handling;
// stub just enough of it to drive createReadlineAdapter() in isolation.
const questionMock = vi.fn().mockResolvedValue("answer");
const pauseMock = vi.fn();
const resumeMock = vi.fn();
vi.mock("node:readline/promises", () => ({
  createInterface: () => ({
    question: questionMock,
    close: vi.fn(),
    pause: pauseMock,
    resume: resumeMock,
  }),
}));

const { createReadlineAdapter } = await import("../../src/ui/readline-adapter.js");

describe("readline UIAdapter busy indicator", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- process.stdout.write's overloaded
  // signature doesn't unify cleanly with a mock implementation; loosen just for this spy.
  let writeSpy: any;

  beforeEach(() => {
    vi.useFakeTimers();
    writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    writeSpy.mockRestore();
    vi.useRealTimers();
  });

  it("writes spinner frames with the given label while busy", () => {
    const ui = createReadlineAdapter();
    ui.setBusy(true, "thinking");

    vi.advanceTimersByTime(200);

    const written = writeSpy.mock.calls.map((c: any[]) => c[0]).join("");
    expect(written).toContain("thinking...");
  });

  it("clears the spinner line when busy is set back to false", () => {
    const ui = createReadlineAdapter();
    ui.setBusy(true, "thinking");
    vi.advanceTimersByTime(100);
    writeSpy.mockClear();

    ui.setBusy(false);

    const written = writeSpy.mock.calls.map((c: any[]) => c[0]).join("");
    expect(written).toContain("\x1b[K"); // clear-line escape sequence
  });

  it("stops the spinner interval once cleared (no further writes after)", () => {
    const ui = createReadlineAdapter();
    ui.setBusy(true, "thinking");
    ui.setBusy(false);
    writeSpy.mockClear();

    vi.advanceTimersByTime(500);

    expect(writeSpy).not.toHaveBeenCalled();
  });

  it("pauses readline as soon as the interface is created (idle by default)", () => {
    pauseMock.mockClear();
    createReadlineAdapter();
    expect(pauseMock).toHaveBeenCalled();
  });

  it("resumes readline only while a question is actually pending, then re-pauses", async () => {
    pauseMock.mockClear();
    resumeMock.mockClear();
    const ui = createReadlineAdapter();

    const answer = await ui.askUser("> ");

    expect(answer).toBe("answer");
    // resume() must happen before question() is called, and pause() after it resolves —
    // this is the fix for the "output looks frozen until the next keystroke" bug:
    // Node's readline desyncs its cursor tracking if raw writes happen while the
    // interface is resumed but no question() is in flight.
    expect(resumeMock).toHaveBeenCalled();
    expect(pauseMock).toHaveBeenCalled();
  });
});

describe("readline UIAdapter assistant message buffering", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let writeSpy: any;

  beforeEach(() => {
    writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    writeSpy.mockRestore();
  });

  it("does not write streamed deltas directly — buffers until endAssistantMessage()", () => {
    const ui = createReadlineAdapter();
    ui.writeAssistantDelta("| a | b |\n");
    ui.writeAssistantDelta("|---|---|\n");
    ui.writeAssistantDelta("| 1 | 2 |");

    const written = writeSpy.mock.calls.map((c: any[]) => c[0]).join("");
    expect(written).not.toContain("| a | b |");
  });

  it("renders the full buffered markdown once endAssistantMessage() is called", () => {
    const ui = createReadlineAdapter();
    ui.writeAssistantDelta("**hello**");
    writeSpy.mockClear();

    ui.endAssistantMessage();

    const written = writeSpy.mock.calls.map((c: any[]) => c[0]).join("");
    expect(written).toContain("hello");
    expect(written).not.toContain("**hello**"); // rendered, not raw markdown
  });

  it("is a no-op when there is nothing buffered", () => {
    const ui = createReadlineAdapter();
    writeSpy.mockClear();

    ui.endAssistantMessage();

    expect(writeSpy).not.toHaveBeenCalled();
  });
});
