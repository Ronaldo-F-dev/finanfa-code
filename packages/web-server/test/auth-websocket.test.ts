import { describe, expect, it } from "vitest";
import { authenticateWebSocketRequest } from "../src/auth.js";
import { SessionTokenStore } from "../src/session-token-store.js";

// token -> username, as parseWebUsers builds it
const users = new Map([["tok-alice", "alice"], ["tok-bob", "bob"]]);
const sessions = new SessionTokenStore();

describe("authenticateWebSocketRequest", () => {
  it("accepts the ?token= query parameter", () => {
    expect(authenticateWebSocketRequest(users, sessions, "/ws?model=m&token=tok-alice", undefined)).toBe("alice");
  });

  it("accepts an Authorization: Bearer header when there is no query token", () => {
    expect(authenticateWebSocketRequest(users, sessions, "/ws?model=m", "Bearer tok-bob")).toBe("bob");
  });

  it("lets the query token win when both are present", () => {
    expect(authenticateWebSocketRequest(users, sessions, "/ws?token=tok-alice", "Bearer tok-bob")).toBe("alice");
  });

  it("refuses an unknown token on either path, and a header without the Bearer scheme", () => {
    expect(authenticateWebSocketRequest(users, sessions, "/ws?token=nope", undefined)).toBeUndefined();
    expect(authenticateWebSocketRequest(users, sessions, "/ws", "Bearer nope")).toBeUndefined();
    expect(authenticateWebSocketRequest(users, sessions, "/ws", "tok-alice")).toBeUndefined();
    expect(authenticateWebSocketRequest(users, sessions, "/ws", undefined)).toBeUndefined();
  });

  it("does not fall back to the header when a wrong query token is given", () => {
    expect(authenticateWebSocketRequest(users, sessions, "/ws?token=wrong", "Bearer tok-alice")).toBeUndefined();
  });
});
