import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SerialPort } from "serialport";
import { SerialManager } from "../../src/serial/manager.js";
import { createSerialTools } from "../../src/tools/builtin/serial.js";

const ctx = { cwd: "/tmp", sessionId: "s", signal: new AbortController().signal };

// Real serial communication over a real virtual serial port PAIR created
// by socat (two linked PTYs — writing to one is readable from the
// other), so this exercises the actual serialport library and OS tty
// layer, not a mock. This is the same technique real embedded-tooling
// projects use to test serial code without physical hardware attached.
describe("serial_* tools (real serialport, real socat-linked PTY pair)", () => {
  let socatProcess: ChildProcess;
  let dir: string;
  let ourPortPath: string;
  let peerPort: SerialPort;
  let peerReceived: Buffer[] = [];

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "finanfa-serial-"));
    const linkA = path.join(dir, "ttyA");
    const linkB = path.join(dir, "ttyB");
    ourPortPath = linkA;

    socatProcess = spawn("socat", ["-d", "-d", `pty,raw,echo=0,link=${linkA}`, `pty,raw,echo=0,link=${linkB}`]);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("socat did not create the PTY pair in time")), 5000);
      socatProcess.stderr?.on("data", (chunk: Buffer) => {
        if (chunk.toString().includes("starting data transfer loop")) {
          clearTimeout(timer);
          resolve();
        }
      });
    });

    peerPort = new SerialPort({ path: linkB, baudRate: 115200 });
    await new Promise<void>((resolve, reject) => peerPort.once("open", resolve).once("error", reject));
    peerPort.on("data", (chunk: Buffer) => peerReceived.push(chunk));
  }, 15_000);

  afterAll(async () => {
    peerPort?.close();
    socatProcess?.kill();
    await rm(dir, { recursive: true, force: true });
  });

  it("has the expected risk levels", () => {
    const [listPorts, openPort, writePort, readPort, closePort] = createSerialTools(new SerialManager());
    expect(listPorts.riskLevel).toBe("safe");
    expect(openPort.riskLevel).toBe("ask");
    expect(writePort.riskLevel).toBe("ask");
    expect(readPort.riskLevel).toBe("safe");
    expect(closePort.riskLevel).toBe("safe");
  });

  it("serial_list_ports lists real ports without erroring", async () => {
    const [listPorts] = createSerialTools(new SerialManager());
    const result = await listPorts.handler({}, ctx);
    expect(result.isError).toBe(false);
  });

  it("opens a real port, writes real data, and the real linked peer receives it", async () => {
    const manager = new SerialManager();
    const [, openPort, writePort] = createSerialTools(manager);

    const openResult = await openPort.handler({ path: ourPortPath, baudRate: 115200 }, ctx);
    expect(openResult.isError).toBe(false);

    peerReceived = [];
    const writeResult = await writePort.handler({ data: "hello device" }, ctx);
    expect(writeResult.isError).toBe(false);

    await new Promise((r) => setTimeout(r, 200));
    expect(Buffer.concat(peerReceived).toString()).toBe("hello device\n");

    await manager.close();
  });

  it("appendNewline:false sends the data with no trailing newline", async () => {
    const manager = new SerialManager();
    const [, openPort, writePort] = createSerialTools(manager);
    await openPort.handler({ path: ourPortPath }, ctx);

    peerReceived = [];
    await writePort.handler({ data: "raw", appendNewline: false }, ctx);
    await new Promise((r) => setTimeout(r, 200));
    expect(Buffer.concat(peerReceived).toString()).toBe("raw");

    await manager.close();
  });

  it("serial_read receives real data the peer sends back", async () => {
    const manager = new SerialManager();
    const [, openPort, , readPort] = createSerialTools(manager);
    await openPort.handler({ path: ourPortPath }, ctx);

    peerPort.write("response from device\n");
    const readResult = await readPort.handler({ timeout_ms: 2000 }, ctx);
    expect(readResult.isError).toBe(false);
    expect(readResult.content).toBe("response from device\n");

    await manager.close();
  });

  it("serial_read reports no data instead of hanging when nothing arrives within the timeout", async () => {
    const manager = new SerialManager();
    const [, openPort, , readPort] = createSerialTools(manager);
    await openPort.handler({ path: ourPortPath }, ctx);

    const readResult = await readPort.handler({ timeout_ms: 200 }, ctx);
    expect(readResult.isError).toBe(false);
    expect(readResult.content).toBe("(no data received)");

    await manager.close();
  }, 5_000);

  it("serial_write/serial_read report a clear error when no port is open", async () => {
    const manager = new SerialManager();
    const [, , writePort, readPort] = createSerialTools(manager);
    const writeResult = await writePort.handler({ data: "x" }, ctx);
    expect(writeResult.isError).toBe(true);
    expect(writeResult.content).toContain("No serial port is open");

    const readResult = await readPort.handler({}, ctx);
    expect(readResult.isError).toBe(true);
  });

  it("serial_open reports a real error for a nonexistent port", async () => {
    const manager = new SerialManager();
    const [, openPort] = createSerialTools(manager);
    const result = await openPort.handler({ path: "/dev/ttyDOESNOTEXIST99" }, ctx);
    expect(result.isError).toBe(true);
  });

  it("opening a new port closes a previously open one first", async () => {
    const manager = new SerialManager();
    const [, openPort] = createSerialTools(manager);
    await openPort.handler({ path: ourPortPath }, ctx);
    expect(manager.isOpen()).toBe(true);
    // Opening the same real port again must not throw "port is already open".
    await expect(openPort.handler({ path: ourPortPath }, ctx)).resolves.toEqual(expect.objectContaining({ isError: false }));
    await manager.close();
  });

  it("serial_close closes cleanly even when nothing is open", async () => {
    const manager = new SerialManager();
    const [, , , , closePort] = createSerialTools(manager);
    const result = await closePort.handler({}, ctx);
    expect(result.isError).toBe(false);
  });
});
