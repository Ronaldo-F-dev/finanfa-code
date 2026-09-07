import { SerialPort } from "serialport";

// Real serial/UART communication (the first IoT/electronics capability
// added to this project) via the standard `serialport` npm package (real
// native bindings, not hand-rolled — configuring a tty's baud rate/parity
// needs termios ioctls that plain fs read/write can't reach, so this is
// the same "use a mature library for real functionality" call as
// nodemailer/mysql2/pg elsewhere in this project). Keeps at most one port
// open across tool calls, the same single-shared-resource pattern
// BrowserManager already uses for the browser_* tools.
export interface SerialPortInfo {
  path: string;
  manufacturer?: string;
  vendorId?: string;
  productId?: string;
  serialNumber?: string;
}

export class SerialManager {
  private port: SerialPort | undefined;
  private buffer: Buffer[] = [];

  static async listPorts(): Promise<SerialPortInfo[]> {
    const ports = await SerialPort.list();
    return ports.map((p) => ({ path: p.path, manufacturer: p.manufacturer, vendorId: p.vendorId, productId: p.productId, serialNumber: p.serialNumber }));
  }

  isOpen(): boolean {
    return this.port !== undefined && this.port.isOpen;
  }

  async open(path: string, baudRate: number): Promise<void> {
    await this.close();
    this.buffer = [];
    const port = new SerialPort({ path, baudRate, autoOpen: false });
    port.on("data", (chunk: Buffer) => this.buffer.push(chunk));
    await new Promise<void>((resolve, reject) => {
      port.open((err) => (err ? reject(err) : resolve()));
    });
    this.port = port;
  }

  async write(data: string): Promise<void> {
    if (!this.port || !this.port.isOpen) throw new Error("No serial port is open — call serial_open first.");
    await new Promise<void>((resolve, reject) => {
      this.port!.write(data, (err) => (err ? reject(err) : resolve()));
    });
  }

  /** Drains whatever has arrived since the last read (or since open), waiting up to `timeoutMs` for at least something if the buffer is currently empty — a real device's response arrives asynchronously, so this can't just return immediately. */
  async readAvailable(timeoutMs: number): Promise<string> {
    if (!this.port || !this.port.isOpen) throw new Error("No serial port is open — call serial_open first.");
    if (this.buffer.length === 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        this.port!.once("data", () => {
          clearTimeout(timer);
          // Let the same tick's "data" listener (pushing into this.buffer) run first.
          setImmediate(resolve);
        });
      });
    }
    const chunks = this.buffer;
    this.buffer = [];
    return Buffer.concat(chunks).toString("utf-8");
  }

  async close(): Promise<void> {
    if (this.port?.isOpen) {
      await new Promise<void>((resolve) => this.port!.close(() => resolve()));
    }
    this.port = undefined;
  }
}
