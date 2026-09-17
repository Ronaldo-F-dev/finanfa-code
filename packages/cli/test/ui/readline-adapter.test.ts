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

  it("draws the first spinner frame immediately, not after waiting for the first interval tick", () => {
    const ui = createReadlineAdapter();
    ui.setBusy(true, "thinking");

    // No time advanced at all — a frame must already have been written.
    const written = writeSpy.mock.calls.map((c: any[]) => c[0]).join("");
    expect(written).toContain("thinking...");
  });

  it("renders the spinner in a bold/bright color, not dimmed", () => {
    const ui = createReadlineAdapter();
    ui.setBusy(true, "thinking");

    const written = writeSpy.mock.calls.map((c: any[]) => c[0]).join("");
    expect(written).toContain("\x1b[1;36m"); // bold cyan
    expect(written).not.toContain("\x1b[2m"); // no longer dimmed
  });

  it(
    "shows elapsed time on the spinner — real reported confusion: a slow local model produced no " +
      "visible output for minutes, indistinguishable from a hung process",
    () => {
      const ui = createReadlineAdapter();
      ui.setBusy(true, "thinking");

      vi.advanceTimersByTime(65_000);

      const written = writeSpy.mock.calls.map((c: any[]) => c[0]).join("");
      expect(written).toMatch(/thinking\.\.\. 6[0-9]s/);
    },
  );

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

  it("writeToolCallStarting updates the spinner label while it's already running", () => {
    const ui = createReadlineAdapter();
    ui.setBusy(true, "thinking");
    writeSpy.mockClear();

    ui.writeToolCallStarting?.({ name: "write_file" });

    const written = writeSpy.mock.calls.map((c: any[]) => c[0]).join("");
    expect(written).toContain("calling write_file...");
  });

  it("writeToolCallStarting is a no-op once the spinner has already been cleared", () => {
    const ui = createReadlineAdapter();
    ui.setBusy(true, "thinking");
    ui.setBusy(false);
    writeSpy.mockClear();

    ui.writeToolCallStarting?.({ name: "write_file" });

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

describe("readline UIAdapter writeToolCall", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let writeSpy: any;

  beforeEach(() => {
    writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    writeSpy.mockRestore();
  });

  it("writes the tool name and description", () => {
    const ui = createReadlineAdapter();
    ui.writeToolCall!({ toolCallId: "t1", toolName: "bash", description: "rm -rf /tmp/x", riskLevel: "dangerous" });

    const written = writeSpy.mock.calls.map((c: any[]) => c[0]).join("");
    expect(written).toContain("bash");
    expect(written).toContain("rm -rf /tmp/x");
  });

  it("uses a different color per risk level", () => {
    const ui = createReadlineAdapter();

    ui.writeToolCall!({ toolCallId: "t1", toolName: "read_file", description: "a.txt", riskLevel: "safe" });
    const safeWritten = writeSpy.mock.calls.map((c: any[]) => c[0]).join("");
    writeSpy.mockClear();

    ui.writeToolCall!({ toolCallId: "t1", toolName: "bash", description: "rm x", riskLevel: "dangerous" });
    const dangerousWritten = writeSpy.mock.calls.map((c: any[]) => c[0]).join("");

    expect(safeWritten).toContain("\x1b[36m"); // cyan
    expect(dangerousWritten).toContain("\x1b[31m"); // red
    expect(safeWritten).not.toBe(dangerousWritten);
  });

  it("omits the description part cleanly when there is none", () => {
    const ui = createReadlineAdapter();
    ui.writeToolCall!({ toolCallId: "t1", toolName: "noop", description: "", riskLevel: "safe" });

    const written = writeSpy.mock.calls.map((c: any[]) => c[0]).join("");
    expect(written).toContain("noop");
  });
});
