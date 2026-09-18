import { describe, expect, it, vi, afterEach } from "vitest";
import { waitForRemoteConfirmation, resolvePendingConfirmation, hasPendingConfirmation } from "../../src/channels/pending-confirmations.js";

describe("pending-confirmations", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves the waiting promise with the answer given to resolvePendingConfirmation", async () => {
    const promise = waitForRemoteConfirmation("session-a");
    expect(hasPendingConfirmation("session-a")).toBe(true);

    expect(resolvePendingConfirmation("session-a", "y")).toBe(true);
    await expect(promise).resolves.toBe("y");
    expect(hasPendingConfirmation("session-a")).toBe(false);
  });

  it("returns false and does nothing for a session with no pending confirmation", () => {
    expect(resolvePendingConfirmation("no-such-session", "y")).toBe(false);
  });

  it("keeps separate sessions' pending confirmations independent", async () => {
    const promiseA = waitForRemoteConfirmation("session-b1");
    const promiseB = waitForRemoteConfirmation("session-b2");

    resolvePendingConfirmation("session-b2", "n");
    await expect(promiseB).resolves.toBe("n");
    expect(hasPendingConfirmation("session-b1")).toBe(true); // untouched by resolving the other one

    resolvePendingConfirmation("session-b1", "y");
    await expect(promiseA).resolves.toBe("y");
  });

  it("fails closed with 'n' (matching PermissionManager's own deny answer) if nothing answers in time", async () => {
    vi.useFakeTimers();
    const promise = waitForRemoteConfirmation("session-timeout");
    const assertion = expect(promise).resolves.toBe("n");
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await assertion;
    expect(hasPendingConfirmation("session-timeout")).toBe(false);
  });
});
