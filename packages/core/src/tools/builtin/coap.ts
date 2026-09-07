import coap from "coap";
import type { ToolDefinition } from "../../core/types.js";

// A CoAP client tool — the third IoT network protocol added to this
// project (after MQTT), for constrained devices that speak CoAP instead
// (common in low-power sensor networks, some smart-home/building-
// automation gear). Uses the standard `coap` npm package (mature, pure-JS
// CoAP implementation over UDP — no native bindings needed).
const DEFAULT_TIMEOUT_MS = 5_000;

interface CoapRequestInput {
  uri: string;
  method?: "GET" | "POST" | "PUT" | "DELETE";
  payload?: string;
  confirmable?: boolean;
  observe?: boolean;
  timeout_ms?: number;
}

function parseCoapUri(uri: string): { hostname: string; port: number; pathname: string } {
  const url = new URL(uri);
  if (url.protocol !== "coap:" && url.protocol !== "coaps:") throw new Error(`"${uri}" is not a coap:// or coaps:// URI`);
  return { hostname: url.hostname, port: url.port ? Number(url.port) : 5683, pathname: url.pathname + url.search };
}

export const coapRequestTool: ToolDefinition<CoapRequestInput> = {
  name: "coap_request",
  description:
    "Send a single CoAP request (GET/POST/PUT/DELETE) to a constrained device or CoAP server and return its " +
    "response. Pass a coap:// URI (e.g. 'coap://192.168.1.50/sensors/temperature'). Confirmable (the CoAP " +
    "default, like a TCP-style reliable delivery) unless confirmable:false is set for a fire-and-forget " +
    "non-confirmable message. Set observe:true to register an observation and collect a few updates instead " +
    "of a single response, within timeout_ms. " +
    "IMPORTANT: POST/PUT/DELETE send real, possibly state-changing requests to a real device — confirm with " +
    "the user before calling this with a mutating method unless they've explicitly asked for it.",
  riskLevel: "ask",
  inputSchema: {
    type: "object",
    properties: {
      uri: { type: "string", description: "coap:// URI, e.g. coap://192.168.1.50/sensors/temperature" },
      method: { type: "string", enum: ["GET", "POST", "PUT", "DELETE"], description: "CoAP method (default GET)" },
      payload: { type: "string", description: "Request payload (for POST/PUT)" },
      confirmable: { type: "boolean", description: "Use a confirmable (reliable) message (default true)" },
      observe: { type: "boolean", description: "Observe the resource and collect a few updates instead of one response (default false)" },
      timeout_ms: { type: "number", description: "Timeout in milliseconds (default 5000)" },
    },
    required: ["uri"],
  },
  riskKey: (input) => `coap_request:${input.method ?? "GET"}`,
  describeCall: (input) => `${input.method ?? "GET"} ${input.uri}`,
  async handler(input) {
    let target: { hostname: string; port: number; pathname: string };
    try {
      target = parseCoapUri(input.uri);
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), isError: true };
    }

    return new Promise((resolve) => {
      const timeoutMs = input.timeout_ms ?? DEFAULT_TIMEOUT_MS;
      let settled = false;
      const finish = (result: { content: string; isError: boolean }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => finish({ content: `Timed out waiting for a response from ${input.uri}.`, isError: true }), timeoutMs);

      const req = coap.request({
        hostname: target.hostname,
        port: target.port,
        pathname: target.pathname,
        method: input.method ?? "GET",
        confirmable: input.confirmable ?? true,
        observe: input.observe ?? false,
      });

      req.on("error", (err: Error) => finish({ content: `CoAP request failed: ${err.message}`, isError: true }));

      if (input.observe) {
        const updates: string[] = [];
        req.on("response", (res: coap.IncomingMessage) => {
          res.on("data", (chunk: Buffer) => {
            updates.push(chunk.toString("utf-8"));
            if (updates.length >= 5) req.emit("finishObserve");
          });
        });
        req.on("finishObserve", () => {
          finish({ content: updates.length > 0 ? updates.map((u, i) => `[${i}] ${u}`).join("\n") : "No observed updates received within the timeout.", isError: false });
        });
        setTimeout(() => req.emit("finishObserve"), timeoutMs - 100);
      } else {
        req.on("response", (res: coap.IncomingMessage) => {
          finish({ content: `[${res.code}] ${res.payload.toString("utf-8")}`, isError: !res.code.startsWith("2") });
        });
      }

      req.end(input.payload ?? "");
    });
  },
};
