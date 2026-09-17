export interface SmsMessageEvent {
  /** The sender's real phone number, E.164 format (e.g. "+15551234567") — also the address used to reply. */
  from: string;
  messageSid: string;
  text: string;
}

export type ParsedSmsPayload = { kind: "message"; event: SmsMessageEvent } | { kind: "ignored" };

/**
 * Twilio's inbound SMS webhook is a plain form-urlencoded POST (already
 * parsed to a string-keyed object by the time this runs — see
 * channels-sms.ts's own express.urlencoded() middleware), not JSON like
 * every other channel here. Only `From`/`Body`/`MessageSid` are read; an
 * MMS's media attachments (`NumMedia`/`MediaUrl0`, ...) are ignored for
 * now, same scope boundary the other channels' own inbound parsing
 * started with.
 */
export function parseTwilioSmsPayload(params: Record<string, string>): ParsedSmsPayload {
  const from = params.From;
  const messageSid = params.MessageSid;
  const text = params.Body;
  if (typeof from !== "string" || typeof messageSid !== "string" || typeof text !== "string") {
    return { kind: "ignored" };
  }
  return { kind: "message", event: { from, messageSid, text } };
}
