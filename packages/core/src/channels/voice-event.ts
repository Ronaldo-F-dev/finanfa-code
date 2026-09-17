// Twilio Programmable Voice inbound webhook parsing + TwiML response
// building — the real-time voice/telephony gap relative to a comparable
// project we audited against. Twilio Voice's webhook contract is
// fundamentally synchronous (unlike SMS/WhatsApp's "ack immediately,
// reply asynchronously" webhooks): the caller is on a live phone call
// waiting on hold while this HTTP request is in flight, so the response
// itself is what the caller hears next — there's no separate "send a
// message back later" API call the way SMS/WhatsApp have. That's a real,
// structural constraint this channel has to live with (see
// channels-voice.ts's timeout handling), not something to route around.

export interface VoiceCallStartEvent {
  callSid: string;
  from: string;
  to: string;
}

export interface VoiceSpeechEvent {
  callSid: string;
  from: string;
  /** Undefined when Twilio's own speech recognition heard nothing (a silent caller, background noise only). */
  speechResult?: string;
}

export function parseVoiceCallStart(params: Record<string, string>): VoiceCallStartEvent | undefined {
  const callSid = params.CallSid;
  const from = params.From;
  const to = params.To;
  if (!callSid || !from || !to) return undefined;
  return { callSid, from, to };
}

export function parseVoiceSpeech(params: Record<string, string>): VoiceSpeechEvent | undefined {
  const callSid = params.CallSid;
  const from = params.From;
  if (!callSid || !from) return undefined;
  return { callSid, from, speechResult: params.SpeechResult || undefined };
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** Speaks `sayText` (if given) then listens for the caller's next reply, POSTing the transcript to `actionUrl`. Hangs up with `noInputText` if the caller says nothing within Twilio's own speechTimeout. */
export function gatherSpeechTwiml(actionUrl: string, sayText: string | undefined, noInputText: string): string {
  const sayBlock = sayText ? `<Say>${escapeXml(sayText)}</Say>` : "";
  return (
    `<?xml version="1.0" encoding="UTF-8"?><Response><Gather input="speech" action="${escapeXml(actionUrl)}" method="POST" speechTimeout="auto">` +
    `${sayBlock}</Gather><Say>${escapeXml(noInputText)}</Say></Response>`
  );
}

/** Speaks `text` and ends the call — used for the final reply of a call, or a fallback when the turn couldn't complete before Twilio's own webhook timeout. */
export function sayAndHangupTwiml(text: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say>${escapeXml(text)}</Say><Hangup/></Response>`;
}
