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

export interface WaitForPortPollResult {
  ready: boolean;
  attempts: number;
}

/**
 * The actual poll loop behind the wait_for_port tool, exported so other
 * tool implementations (e.g. run_ios_ssh_command tunneling through
 * iproxy) can wait for a real port to be ready without either duplicating
 * this loop or going through the tool-call layer just to poll a socket.
 * `shouldAbort` lets a caller stop early (e.g. the thing that was
 * supposed to bind the port already died) instead of waiting out the
 * full timeout.
 */
export async function waitForPort(host: string, port: number, timeoutMs: number, opts: { pollIntervalMs?: number; shouldAbort?: () => boolean } = {}): Promise<WaitForPortPollResult> {
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  for (;;) {
    attempts++;
    if (await canConnect(host, port)) return { ready: true, attempts };
    if (opts.shouldAbort?.()) return { ready: false, attempts };
    if (Date.now() >= deadline) return { ready: false, attempts };
    await sleep(opts.pollIntervalMs ?? POLL_INTERVAL_MS);
  }
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
    "connections, instead of guessing a fixed `sleep N`, a server with a debug/reload mode can take longer " +
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
    const result = await waitForPort(host, input.port, timeoutMs);
    if (result.ready) {
      return { content: `${host}:${input.port} is accepting connections (after ${result.attempts} attempt(s)).`, isError: false };
    }
    return {
      content: `${host}:${input.port} did not accept connections within ${timeoutMs}ms (${result.attempts} attempt(s)), the server may have failed to start; check its logs.`,
      isError: true,
    };
  },
};
