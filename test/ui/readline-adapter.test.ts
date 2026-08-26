import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// node:readline/promises' createInterface pulls in real stdin handling;
// stub just enough of it to drive createReadlineAdapter() in isolation.
const questionMock = vi.fn();
vi.mock("node:readline/promises", () => ({
  createInterface: () => ({
    question: questionMock,
    close: vi.fn(),
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
});
