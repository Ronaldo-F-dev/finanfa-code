import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { verifyWhatsappSignature } from "../../src/channels/whatsapp-signature.js";

const APP_SECRET = "test-app-secret";

function sign(rawBody: string, secret = APP_SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

describe("verifyWhatsappSignature (real HMAC-SHA256, node:crypto)", () => {
  it("accepts a genuinely valid signature", () => {
    const rawBody = JSON.stringify({ object: "whatsapp_business_account" });
    const signatureHeader = sign(rawBody);

    expect(verifyWhatsappSignature({ appSecret: APP_SECRET, signatureHeader, rawBody })).toBe(true);
  });

  it("rejects a signature computed with a different app secret", () => {
    const rawBody = "some body";
    const signatureHeader = sign(rawBody, "wrong-secret");

    expect(verifyWhatsappSignature({ appSecret: APP_SECRET, signatureHeader, rawBody })).toBe(false);
  });

  it("rejects a signature over a different body than what's presented (tamper detection)", () => {
    const signatureHeader = sign("original body");

    expect(verifyWhatsappSignature({ appSecret: APP_SECRET, signatureHeader, rawBody: "tampered body" })).toBe(false);
  });

  it("rejects a missing signature header", () => {
    expect(verifyWhatsappSignature({ appSecret: APP_SECRET, signatureHeader: undefined, rawBody: "x" })).toBe(false);
  });

  it("rejects a header missing the 'sha256=' prefix", () => {
    const rawBody = "x";
    const bareHex = createHmac("sha256", APP_SECRET).update(rawBody).digest("hex");
    expect(verifyWhatsappSignature({ appSecret: APP_SECRET, signatureHeader: bareHex, rawBody })).toBe(false);
  });

  it("rejects a forged signature of a different length instead of throwing", () => {
    expect(verifyWhatsappSignature({ appSecret: APP_SECRET, signatureHeader: "sha256=short", rawBody: "x" })).toBe(false);
  });
});
