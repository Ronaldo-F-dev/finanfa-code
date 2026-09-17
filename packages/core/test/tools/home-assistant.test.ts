import { describe, expect, it, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  createGetSmartHomeStateTool,
  createControlSmartHomeDeviceTool,
  homeAssistantConfigFromEnv,
  getHomeAssistantEntityState,
  callHomeAssistantService,
} from "../../src/tools/builtin/home-assistant.js";

const ctx = { cwd: "/tmp", sessionId: "s", signal: new AbortController().signal };

describe("Home Assistant tools (real local HTTP server speaking the Home Assistant REST API shape)", () => {
  let server: http.Server;
  let baseUrl: string;
  let lastRequest: { method: string | undefined; url: string | undefined; headers: http.IncomingHttpHeaders; body: string } | undefined;
  let stateResponse: { status: number; body: unknown } | undefined;
  let serviceCallResponse: { status: number; body?: unknown } | undefined;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        lastRequest = { method: req.method, url: req.url, headers: req.headers, body };
        if (req.url?.startsWith("/api/states/")) {
          const r = stateResponse ?? { status: 200, body: { state: "on", attributes: { brightness: 128, friendly_name: "Living Room" } } };
          res.writeHead(r.status, { "content-type": "application/json" });
          res.end(JSON.stringify(r.body));
          return;
        }
        const r = serviceCallResponse ?? { status: 200, body: [] };
        res.writeHead(r.status, { "content-type": "application/json" });
        res.end(JSON.stringify(r.body ?? []));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.close();
  });

  it("get_smart_home_state reads a real entity's state and attributes over a Bearer-authenticated request", async () => {
    const tool = createGetSmartHomeStateTool({ baseUrl, token: "real-looking-token" });
    const result = await tool.handler({ entity_id: "light.living_room" }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("light.living_room: on");
    expect(result.content).toContain("brightness");
    expect(lastRequest?.method).toBe("GET");
    expect(lastRequest?.url).toBe("/api/states/light.living_room");
    expect(lastRequest?.headers.authorization).toBe("Bearer real-looking-token");
  });

  it("get_smart_home_state reports a real Home Assistant error (e.g. unknown entity)", async () => {
    stateResponse = { status: 404, body: { message: "Entity not found" } };
    const tool = createGetSmartHomeStateTool({ baseUrl, token: "t" });
    const result = await tool.handler({ entity_id: "light.nonexistent" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Entity not found");
    stateResponse = undefined;
  });

  it("control_smart_home_device calls the right domain's service, derived from the entity id", async () => {
    const tool = createControlSmartHomeDeviceTool({ baseUrl, token: "t" });
    const result = await tool.handler({ entity_id: "light.living_room", action: "turn_on" }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toBe("light.living_room: turn_on.");
    expect(lastRequest?.method).toBe("POST");
    expect(lastRequest?.url).toBe("/api/services/light/turn_on");
    expect(JSON.parse(lastRequest!.body)).toEqual({ entity_id: "light.living_room" });

    await tool.handler({ entity_id: "switch.coffee_maker", action: "toggle" }, ctx);
    expect(lastRequest?.url).toBe("/api/services/switch/toggle");
  });

  it("control_smart_home_device reports a real Home Assistant error", async () => {
    serviceCallResponse = { status: 400, body: { message: "Unable to find service" } };
    const tool = createControlSmartHomeDeviceTool({ baseUrl, token: "t" });
    const result = await tool.handler({ entity_id: "light.living_room", action: "turn_off" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Unable to find service");
    serviceCallResponse = undefined;
  });

  it("reports a clear error when Home Assistant is not configured, instead of throwing", async () => {
    const stateTool = createGetSmartHomeStateTool(undefined);
    const stateResult = await stateTool.handler({ entity_id: "light.living_room" }, ctx);
    expect(stateResult.isError).toBe(true);
    expect(stateResult.content).toContain("Home Assistant is not configured");

    const controlTool = createControlSmartHomeDeviceTool(undefined);
    const controlResult = await controlTool.handler({ entity_id: "light.living_room", action: "turn_on" }, ctx);
    expect(controlResult.isError).toBe(true);
    expect(controlResult.content).toContain("Home Assistant is not configured");
  });

  it("has the expected risk levels: safe to read state, ask to control a device", () => {
    expect(createGetSmartHomeStateTool({ baseUrl, token: "t" }).riskLevel).toBe("safe");
    expect(createControlSmartHomeDeviceTool({ baseUrl, token: "t" }).riskLevel).toBe("ask");
  });
});

describe("callHomeAssistantService rejects a malformed entity id before making a request", () => {
  it("reports a clear error instead of calling a service with an empty domain", async () => {
    const result = await callHomeAssistantService({ baseUrl: "http://127.0.0.1:1", token: "t" }, "", "turn_on");
    expect(result).toEqual({ ok: false, error: expect.stringContaining("isn't a valid Home Assistant entity id") });
  });
});

describe("getHomeAssistantEntityState / callHomeAssistantService retry behavior (real local HTTP server)", () => {
  let server: http.Server;
  let baseUrl: string;
  let requestCount: number;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        requestCount++;
        if (requestCount === 1) {
          res.writeHead(429, { "content-type": "application/json", "retry-after": "0" });
          res.end(JSON.stringify({ message: "rate limited" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(req.url?.startsWith("/api/states/") ? JSON.stringify({ state: "off", attributes: {} }) : JSON.stringify([]));
        void body;
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.close();
  });

  it("getHomeAssistantEntityState retries a real 429 and succeeds on the next attempt", async () => {
    requestCount = 0;
    const result = await getHomeAssistantEntityState({ baseUrl, token: "t" }, "light.x");
    expect(result).toEqual({ ok: true, state: "off", attributes: {} });
    expect(requestCount).toBe(2);
  });

  it("callHomeAssistantService retries a real 429 and succeeds on the next attempt", async () => {
    requestCount = 0;
    const result = await callHomeAssistantService({ baseUrl, token: "t" }, "light.x", "turn_on");
    expect(result).toEqual({ ok: true });
    expect(requestCount).toBe(2);
  });
});

describe("homeAssistantConfigFromEnv", () => {
  it("returns undefined unless both env vars are set", () => {
    expect(homeAssistantConfigFromEnv({})).toBeUndefined();
    expect(homeAssistantConfigFromEnv({ HOME_ASSISTANT_BASE_URL: "http://x" } as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it("builds a config from real env-var-shaped input, stripping a trailing slash", () => {
    expect(homeAssistantConfigFromEnv({ HOME_ASSISTANT_BASE_URL: "http://homeassistant.local:8123/", HOME_ASSISTANT_TOKEN: "t" } as NodeJS.ProcessEnv)).toEqual({
      baseUrl: "http://homeassistant.local:8123",
      token: "t",
    });
  });
});
