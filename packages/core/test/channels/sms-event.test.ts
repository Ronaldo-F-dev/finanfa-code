import { describe, expect, it } from "vitest";
import { parseTwilioSmsPayload } from "../../src/channels/sms-event.js";

describe("parseTwilioSmsPayload", () => {
  it("extracts a plain inbound SMS", () => {
    const result = parseTwilioSmsPayload({ From: "+15551234567", To: "+15559876543", Body: "hello", MessageSid: "SMxxxxxxxx", NumMedia: "0" });
    expect(result).toEqual({ kind: "message", event: { from: "+15551234567", messageSid: "SMxxxxxxxx", text: "hello" } });
  });

  it("ignores a payload missing a required field", () => {
    expect(parseTwilioSmsPayload({ From: "+15551234567", Body: "hi" })).toEqual({ kind: "ignored" });
    expect(parseTwilioSmsPayload({ Body: "hi", MessageSid: "SM1" })).toEqual({ kind: "ignored" });
    expect(parseTwilioSmsPayload({})).toEqual({ kind: "ignored" });
  });
});
