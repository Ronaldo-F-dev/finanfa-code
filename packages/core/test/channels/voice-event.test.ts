import { describe, expect, it } from "vitest";
import { parseVoiceCallStart, parseVoiceSpeech, gatherSpeechTwiml, sayAndHangupTwiml } from "../../src/channels/voice-event.js";

describe("parseVoiceCallStart", () => {
  it("parses a real Twilio Voice call-start payload", () => {
    const result = parseVoiceCallStart({ CallSid: "CA1", From: "+15551234567", To: "+15559876543" });
    expect(result).toEqual({ callSid: "CA1", from: "+15551234567", to: "+15559876543" });
  });

  it("returns undefined when a required field is missing", () => {
    expect(parseVoiceCallStart({ From: "+1", To: "+2" })).toBeUndefined();
  });
});

describe("parseVoiceSpeech", () => {
  it("parses a real Twilio Voice gather payload with speech recognized", () => {
    const result = parseVoiceSpeech({ CallSid: "CA1", From: "+15551234567", SpeechResult: "what's the weather" });
    expect(result).toEqual({ callSid: "CA1", from: "+15551234567", speechResult: "what's the weather" });
  });

  it("leaves speechResult undefined when Twilio heard nothing", () => {
    const result = parseVoiceSpeech({ CallSid: "CA1", From: "+15551234567", SpeechResult: "" });
    expect(result?.speechResult).toBeUndefined();
  });

  it("returns undefined when CallSid/From are missing", () => {
    expect(parseVoiceSpeech({ SpeechResult: "hi" })).toBeUndefined();
  });
});

describe("gatherSpeechTwiml", () => {
  it("builds a real Gather/Say TwiML document, XML-escaping the spoken text", () => {
    const xml = gatherSpeechTwiml("https://example.com/gather", 'Say "hi" & <listen>', "nothing heard");
    expect(xml).toContain('<Gather input="speech" action="https://example.com/gather" method="POST" speechTimeout="auto">');
    expect(xml).toContain("Say &quot;hi&quot; &amp; &lt;listen&gt;");
    expect(xml).toContain("<Say>nothing heard</Say>");
    expect(xml).not.toContain("<listen>"); // would only appear unescaped if escaping were broken
  });

  it("omits the <Say> prompt block when none is given", () => {
    const xml = gatherSpeechTwiml("https://example.com/gather", undefined, "nothing heard");
    expect(xml).toContain("<Gather");
    expect(xml.match(/<Say>/g)).toHaveLength(1); // only the no-input fallback Say
  });
});

describe("sayAndHangupTwiml", () => {
  it("builds a real Say/Hangup TwiML document, XML-escaping the text", () => {
    const xml = sayAndHangupTwiml('Tom & Jerry said "hi"');
    expect(xml).toContain("Tom &amp; Jerry said &quot;hi&quot;");
    expect(xml).toContain("<Hangup/>");
  });
});
