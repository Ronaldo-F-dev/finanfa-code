import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { retryWithBackoff } from "../../src/util/retry.js";

describe("retryWithBackoff", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the result immediately on first success, no delay", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await retryWithBackoff(fn);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on failure and succeeds within the attempt budget", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce("ok");

    const promise = retryWithBackoff(fn, { attempts: 3, baseDelayMs: 100 });
    await vi.runAllTimersAsync();

    expect(await promise).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("throws the last error once the attempt budget is exhausted", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("always fails"));

    const promise = retryWithBackoff(fn, { attempts: 3, baseDelayMs: 10 });
    const assertion = expect(promise).rejects.toThrow("always fails");
    await vi.runAllTimersAsync();
    await assertion;

    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does not retry when shouldRetry returns false", async () => {
    class PermanentError extends Error {}
    const fn = vi.fn().mockRejectedValue(new PermanentError("not retryable"));

    await expect(
      retryWithBackoff(fn, { attempts: 5, shouldRetry: (err) => !(err instanceof PermanentError) }),
    ).rejects.toThrow("not retryable");

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("backs off exponentially between attempts", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("boom"));
    const promise = retryWithBackoff(fn, { attempts: 3, baseDelayMs: 100 }).catch(() => {});

    await vi.advanceTimersByTimeAsync(0);
    expect(fn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(100); // 1st backoff: 100ms
    expect(fn).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(200); // 2nd backoff: 200ms
    expect(fn).toHaveBeenCalledTimes(3);

    await promise;
  });
});
