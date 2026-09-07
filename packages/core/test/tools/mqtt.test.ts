import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { Aedes } from "aedes";
import { createServer, type Server } from "node:net";
import type { AddressInfo } from "node:net";
import { mqttPublishTool, mqttSubscribeTool } from "../../src/tools/builtin/mqtt.js";

const ctx = { cwd: "/tmp", sessionId: "s", signal: new AbortController().signal };

describe("mqtt_publish / mqtt_subscribe (real Aedes MQTT broker, real mqtt client)", () => {
  let aedes: Aedes;
  let server: Server;
  let brokerUrl: string;

  beforeAll(async () => {
    aedes = await Aedes.createBroker();
    server = createServer(aedes.handle);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    brokerUrl = `mqtt://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    server.close();
    await aedes.close();
  });

  it("has the expected risk levels", () => {
    expect(mqttPublishTool.riskLevel).toBe("ask");
    expect(mqttSubscribeTool.riskLevel).toBe("safe");
  });

  it("publishes a real message that a real subscriber (started first) actually receives", async () => {
    const subscribePromise = mqttSubscribeTool.handler({ brokerUrl, topic: "sensors/temp", timeout_ms: 2000 }, ctx);
    await new Promise((r) => setTimeout(r, 300)); // let the real subscription actually register with the broker before publishing

    const publishResult = await mqttPublishTool.handler({ brokerUrl, topic: "sensors/temp", message: "21.5" }, ctx);
    expect(publishResult.isError).toBe(false);

    const subscribeResult = await subscribePromise;
    expect(subscribeResult.isError).toBe(false);
    expect(subscribeResult.content).toContain("[sensors/temp] 21.5");
  }, 10_000);

  it("matches a wildcard subscription against a real published topic", async () => {
    const subscribePromise = mqttSubscribeTool.handler({ brokerUrl, topic: "sensors/+/humidity", timeout_ms: 2000 }, ctx);
    await new Promise((r) => setTimeout(r, 300));

    await mqttPublishTool.handler({ brokerUrl, topic: "sensors/room1/humidity", message: "48" }, ctx);

    const result = await subscribePromise;
    expect(result.content).toContain("[sensors/room1/humidity] 48");
  }, 10_000);

  it("reports no messages instead of hanging when nothing is published within the timeout", async () => {
    const result = await mqttSubscribeTool.handler({ brokerUrl, topic: "nobody/publishes/here", timeout_ms: 500 }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("No messages received");
  }, 5_000);

  it("reports a real connection failure for an unreachable broker, for both publish and subscribe", async () => {
    const unreachable = "mqtt://127.0.0.1:1";
    const publishResult = await mqttPublishTool.handler({ brokerUrl: unreachable, topic: "x", message: "y" }, ctx);
    expect(publishResult.isError).toBe(true);

    const subscribeResult = await mqttSubscribeTool.handler({ brokerUrl: unreachable, topic: "x" }, ctx);
    expect(subscribeResult.isError).toBe(true);
  }, 15_000);

  it("scopes the publish riskKey by broker URL", () => {
    expect(mqttPublishTool.riskKey?.({ brokerUrl, topic: "t", message: "m" })).toBe(`mqtt_publish:${brokerUrl}`);
  });
});
