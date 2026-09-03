import net from "node:net";
import type { ToolDefinition } from "../../core/types.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 500;
const CONNECT_TIMEOUT_MS = 1_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port, timeout: CONNECT_TIMEOUT_MS });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

interface WaitForPortInput {
  port: number;
  host?: string;
  timeout_ms?: number;
}

export const waitForPortTool: ToolDefinition<WaitForPortInput> = {
  name: "wait_for_port",
  description:
    "Poll a TCP port (e.g. a dev server you just started with start_background_process) until it accepts " +
    "connections, instead of guessing a fixed `sleep N` — a server with a debug/reload mode can take longer " +
    "to bind its port than a guessed sleep duration, and testing too early looks exactly like a crash when " +
    "it isn't. Returns as soon as the port is reachable, or reports failure once the timeout elapses.",
  riskLevel: "safe",
  inputSchema: {
    type: "object",
    properties: {
      port: { type: "number" },
      host: { type: "string", description: 'Default "localhost"' },
      timeout_ms: { type: "number", description: "Default 30000" },
    },
    required: ["port"],
  },
  describeCall: (input) => `wait for ${input.host ?? "localhost"}:${input.port}`,
  async handler(input) {
    const host = input.host ?? "localhost";
    const timeoutMs = input.timeout_ms ?? DEFAULT_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    let attempts = 0;

    for (;;) {
      attempts++;
      if (await canConnect(host, input.port)) {
        return { content: `${host}:${input.port} is accepting connections (after ${attempts} attempt(s)).`, isError: false };
      }
      if (Date.now() >= deadline) {
        return {
          content: `${host}:${input.port} did not accept connections within ${timeoutMs}ms (${attempts} attempt(s)) — the server may have failed to start; check its logs.`,
          isError: true,
        };
      }
      await sleep(POLL_INTERVAL_MS);
    }
  },
};
