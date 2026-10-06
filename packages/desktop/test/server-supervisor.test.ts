import { describe, expect, it } from "vitest";
import { startServer } from "../src/server-supervisor.js";

const node = process.execPath;
const spec = (script: string) => ({ command: node, args: ["-e", script], env: { ...process.env } });
const READY = `console.log("finanfa-code-web server listening on http://localhost:4242 (bound to 127.0.0.1)");`;

describe("startServer", () => {
  it("resolves with the port once the ready line appears, and stops the process on request", async () => {
    const server = await startServer(spec(`${READY} setInterval(() => {}, 1000);`), process.cwd());
    expect(server.port).toBe(4242);
    expect(server.output()).toContain("listening on");
    await server.stop();
    await server.stop(); // idempotent
  });

  it("stops a server that ignores SIGTERM", async () => {
    const server = await startServer(spec(`process.on("SIGTERM", () => {}); ${READY} setInterval(() => {}, 1000);`), process.cwd());
    const started = Date.now();
    await server.stop();
    expect(Date.now() - started).toBeLessThan(8000);
  }, 15_000);

  it("kills the server's own children too (the whole process group)", async () => {
    const script = `
      const { spawn } = require("node:child_process");
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      console.log("child-pid=" + child.pid);
      ${READY}
      setInterval(() => {}, 1000);`;
    const server = await startServer(spec(script), process.cwd());
    const childPid = Number(/child-pid=(\d+)/.exec(server.output())?.[1]);
    expect(childPid).toBeGreaterThan(0);
    await server.stop();
    await new Promise((r) => setTimeout(r, 300));
    expect(() => process.kill(childPid, 0)).toThrow(); // ESRCH: gone
  }, 15_000);

  it("reports a crash after startup through `crashed`, but not a stop we asked for", async () => {
    const crashing = await startServer(spec(`${READY} setTimeout(() => process.exit(3), 200);`), process.cwd());
    expect(await crashing.crashed).toBe(3);

    const stopped = await startServer(spec(`${READY} setInterval(() => {}, 1000);`), process.cwd());
    let settled = false;
    void stopped.crashed.then(() => (settled = true));
    await stopped.stop();
    await new Promise((r) => setTimeout(r, 200));
    expect(settled).toBe(false);
  }, 15_000);

  it("rejects with the output when the server dies before it is ready", async () => {
    await expect(startServer(spec(`console.error("boom: missing config"); process.exit(1);`), process.cwd())).rejects.toThrow(/exited before it was ready.*boom: missing config/s);
  });

  it("rejects when the server never says it is ready", async () => {
    await expect(startServer(spec(`setInterval(() => {}, 1000);`), process.cwd(), 400)).rejects.toThrow(/did not start within/);
  });

  it("rejects when the command does not exist", async () => {
    await expect(startServer({ command: "/nonexistent/binary", args: [], env: {} }, process.cwd())).rejects.toThrow(/Could not start the server/);
  });
});
