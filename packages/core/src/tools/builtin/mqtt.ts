import mqtt from "mqtt";
import type { ToolDefinition } from "../../core/types.js";

// MQTT client tools — the second IoT capability added to this project,
// for talking to devices already reachable over the network (a broker
// somewhere), complementing the serial_*/run_esptool/run_avrdude tools
// (which need a device physically attached to this machine). Uses the
// standard `mqtt` npm package (a mature, pure-JS MQTT client — no native
// bindings needed, same "use a real library for real protocol work" call
// as nodemailer for SMTP).
//
// Each call opens its own short-lived connection, does one publish or one
// timed subscribe-and-collect, then disconnects — matching how a human
// would use mosquitto_pub/mosquitto_sub (one-shot CLI invocations), not a
// long-lived interactive session like the serial_*/browser_* tools keep.
const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_SUBSCRIBE_TIMEOUT_MS = 5_000;
const MAX_MESSAGES_COLLECTED = 100;

interface MqttPublishInput {
  brokerUrl: string;
  topic: string;
  message: string;
  qos?: 0 | 1 | 2;
  retain?: boolean;
}

interface MqttSubscribeInput {
  brokerUrl: string;
  topic: string;
  timeout_ms?: number;
  qos?: 0 | 1 | 2;
}

function connectClient(brokerUrl: string): Promise<mqtt.MqttClient> {
  return new Promise((resolve, reject) => {
    const client = mqtt.connect(brokerUrl, { connectTimeout: DEFAULT_CONNECT_TIMEOUT_MS, reconnectPeriod: 0 });
    const onError = (err: Error) => {
      client.end(true);
      reject(err);
    };
    client.once("connect", () => {
      client.removeListener("error", onError);
      resolve(client);
    });
    client.once("error", onError);
  });
}

export const mqttPublishTool: ToolDefinition<MqttPublishInput> = {
  name: "mqtt_publish",
  description:
    "Publish one message to an MQTT topic (connects, publishes, disconnects — a one-shot call, like " +
    "mosquitto_pub). IMPORTANT: this sends a real message to a real broker, which may cause a real device to " +
    "act on it — confirm the broker/topic/message with the user before calling this unless they've explicitly " +
    "asked for this exact publish.",
  riskLevel: "ask",
  inputSchema: {
    type: "object",
    properties: {
      brokerUrl: { type: "string", description: "Broker URL, e.g. mqtt://broker.example.com:1883 or mqtts://... for TLS" },
      topic: { type: "string", description: "Topic to publish to" },
      message: { type: "string", description: "Message payload" },
      qos: { type: "number", enum: [0, 1, 2], description: "Quality of service level (default 0)" },
      retain: { type: "boolean", description: "Whether the broker should retain this message for future subscribers (default false)" },
    },
    required: ["brokerUrl", "topic", "message"],
  },
  riskKey: (input) => `mqtt_publish:${input.brokerUrl}`,
  describeCall: (input) => `publish to ${input.topic} on ${input.brokerUrl}`,
  async handler(input) {
    let client: mqtt.MqttClient;
    try {
      client = await connectClient(input.brokerUrl);
    } catch (err) {
      return { content: `Failed to connect to ${input.brokerUrl}: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
    try {
      await new Promise<void>((resolve, reject) => {
        client.publish(input.topic, input.message, { qos: input.qos ?? 0, retain: input.retain ?? false }, (err) => (err ? reject(err) : resolve()));
      });
      return { content: `Published to ${input.topic} on ${input.brokerUrl}.`, isError: false };
    } catch (err) {
      return { content: `Failed to publish: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    } finally {
      // NOT end(true) (force): a forced close can cut the connection
      // before the just-published packet has actually finished flushing
      // to the socket, even though the publish callback already fired —
      // confirmed as a real bug while testing this against a real broker
      // (the message reliably never arrived with force:true). A graceful
      // end() waits for the outstanding write to actually drain first.
      client.end();
    }
  },
};

export const mqttSubscribeTool: ToolDefinition<MqttSubscribeInput> = {
  name: "mqtt_subscribe",
  description:
    "Subscribe to an MQTT topic (supports wildcards, e.g. 'sensors/+/temperature' or 'sensors/#') and collect " +
    `whatever messages arrive within timeout_ms (default 5000), then disconnect — a one-shot snapshot, not a ` +
    "persistent subscription (like `mosquitto_sub -W <seconds>`).",
  riskLevel: "safe",
  inputSchema: {
    type: "object",
    properties: {
      brokerUrl: { type: "string", description: "Broker URL, e.g. mqtt://broker.example.com:1883" },
      topic: { type: "string", description: "Topic (or wildcard pattern) to subscribe to" },
      timeout_ms: { type: "number", description: "How long to collect messages for (default 5000ms)" },
      qos: { type: "number", enum: [0, 1, 2], description: "Quality of service level (default 0)" },
    },
    required: ["brokerUrl", "topic"],
  },
  describeCall: (input) => `subscribe to ${input.topic} on ${input.brokerUrl}`,
  async handler(input) {
    let client: mqtt.MqttClient;
    try {
      client = await connectClient(input.brokerUrl);
    } catch (err) {
      return { content: `Failed to connect to ${input.brokerUrl}: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }

    const messages: { topic: string; payload: string }[] = [];
    client.on("message", (topic, payload) => {
      if (messages.length < MAX_MESSAGES_COLLECTED) messages.push({ topic, payload: payload.toString("utf-8") });
    });

    try {
      await new Promise<void>((resolve, reject) => {
        client.subscribe(input.topic, { qos: input.qos ?? 0 }, (err) => (err ? reject(err) : resolve()));
      });
      await new Promise((resolve) => setTimeout(resolve, input.timeout_ms ?? DEFAULT_SUBSCRIBE_TIMEOUT_MS));

      if (messages.length === 0) return { content: `No messages received on "${input.topic}" within the timeout.`, isError: false };
      const lines = messages.map((m) => `[${m.topic}] ${m.payload}`);
      return { content: lines.join("\n"), isError: false };
    } catch (err) {
      return { content: `Failed to subscribe: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    } finally {
      client.end(true);
    }
  },
};
