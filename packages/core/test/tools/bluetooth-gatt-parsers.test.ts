import { describe, expect, it } from "vitest";
import { normalizeGattWriteBytes, parseGattConnectResult, parseGattWriteResult } from "../../src/tools/builtin/security/bluetooth-gatt.js";

describe("normalizeGattWriteBytes", () => {
  it("accepts space-separated, bare, and 0x-prefixed hex, normalizing to lowercase byte tokens", () => {
    expect(normalizeGattWriteBytes("01 02 FF")).toEqual({ bytes: ["01", "02", "ff"] });
    expect(normalizeGattWriteBytes("0102ff")).toEqual({ bytes: ["01", "02", "ff"] });
    expect(normalizeGattWriteBytes("0x01 0x02")).toEqual({ bytes: ["01", "02"] });
    expect(normalizeGattWriteBytes("01,02,03")).toEqual({ bytes: ["01", "02", "03"] });
  });

  it("rejects empty, non-hex, and odd-length input rather than writing garbage", () => {
    expect(normalizeGattWriteBytes("")).toEqual({ error: expect.stringMatching(/no value to write/i) });
    expect(normalizeGattWriteBytes("   ")).toEqual({ error: expect.stringMatching(/no value to write/i) });
    expect(normalizeGattWriteBytes("hello")).toEqual({ error: expect.stringMatching(/not valid hex/i) });
    expect(normalizeGattWriteBytes("0f1")).toEqual({ error: expect.stringMatching(/odd number of hex digits/i) });
  });
});

describe("parseGattConnectResult", () => {
  it("is true for a fresh or already-live connection, false otherwise", () => {
    expect(parseGattConnectResult("Attempting to connect to AA:BB\nConnection successful")).toBe(true);
    expect(parseGattConnectResult("Device AA:BB already connected")).toBe(true);
    expect(parseGattConnectResult("Attempting to connect to AA:BB\nFailed to connect: org.bluez.Error.Failed")).toBe(false);
    expect(parseGattConnectResult("")).toBe(false);
  });
});

describe("parseGattWriteResult", () => {
  it("treats an attempted write with no error marker as success", () => {
    expect(parseGattWriteResult("Attempting to write /org/bluez/hci0/dev_AA/char0003")).toEqual({ ok: true });
  });

  it("surfaces the peripheral's own rejection line, plain-text or org.bluez.Error.*", () => {
    expect(parseGattWriteResult("Attempting to write ...\nNot permitted")).toEqual({ ok: false, detail: "Not permitted" });
    expect(parseGattWriteResult("Invalid Value Length")).toEqual({ ok: false, detail: "Invalid Value Length" });
    expect(parseGattWriteResult("Failed to write: org.bluez.Error.NotAuthorized")).toMatchObject({ ok: false });
  });

  it("does not optimistically pass when bluetoothctl never acknowledged the write at all", () => {
    expect(parseGattWriteResult("Unknown command: write")).toEqual({ ok: false, detail: "Unknown command: write" });
    expect(parseGattWriteResult("")).toEqual({ ok: false, detail: "no response from bluetoothctl" });
  });
});
