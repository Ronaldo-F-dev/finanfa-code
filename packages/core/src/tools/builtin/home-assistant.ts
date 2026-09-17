import type { ToolDefinition } from "../../core/types.js";
import { fetchWithRetry } from "../../channels/retry-fetch.js";

// A real connector tool for Home Assistant — the smart-home integration
// gap (alongside Notion/Trello/Spotify) relative to a comparable project
// we audited against. Home Assistant is the de facto standard
// self-hosted smart-home hub (thousands of device integrations behind
// one REST API), so wrapping its own stable REST API covers far more
// real devices than integrating any single vendor's cloud API directly
// would. Auth is a long-lived access token (created in Home Assistant's
// own UI, under the user's profile), sent as a bearer token — no OAuth
// flow to automate, unlike Spotify.
export interface HomeAssistantConfig {
  baseUrl: string;
  token: string;
}

export function homeAssistantConfigFromEnv(env: NodeJS.ProcessEnv = process.env): HomeAssistantConfig | undefined {
  const baseUrl = env.HOME_ASSISTANT_BASE_URL;
  const token = env.HOME_ASSISTANT_TOKEN;
  return baseUrl && token ? { baseUrl: baseUrl.replace(/\/+$/, ""), token } : undefined;
}

interface HomeAssistantErrorBody {
  message?: string;
}

export type GetEntityStateResult = { ok: true; state: string; attributes: Record<string, unknown> } | { ok: false; error: string };

/** GET /api/states/<entity_id> — a single entity's current state (e.g. "on"/"off"/a temperature reading) and its attributes (brightness, unit_of_measurement, friendly_name, ...). */
export async function getHomeAssistantEntityState(config: HomeAssistantConfig, entityId: string): Promise<GetEntityStateResult> {
  let response: Response;
  let bodyText: string;
  try {
    ({ response, bodyText } = await fetchWithRetry(`${config.baseUrl}/api/states/${encodeURIComponent(entityId)}`, { headers: { Authorization: `Bearer ${config.token}` } }));
  } catch (err) {
    return { ok: false, error: `Failed to reach Home Assistant: ${err instanceof Error ? err.message : String(err)}` };
  }

  let data: (HomeAssistantErrorBody & { state?: string; attributes?: Record<string, unknown> }) | undefined;
  try {
    data = JSON.parse(bodyText) as typeof data;
  } catch {
    return { ok: false, error: `Home Assistant returned an unparseable response (HTTP ${response.status}).` };
  }
  if (!response.ok || data?.state === undefined) {
    return { ok: false, error: data?.message ?? `Home Assistant API error (HTTP ${response.status})` };
  }
  return { ok: true, state: data.state, attributes: data.attributes ?? {} };
}

export type SmartHomeAction = "turn_on" | "turn_off" | "toggle";

export type CallServiceResult = { ok: true } | { ok: false; error: string };

/** POST /api/services/<domain>/<service> — the domain is always the entity id's own prefix (e.g. "light.living_room" -> domain "light"), so callers never need to pass it separately. */
export async function callHomeAssistantService(config: HomeAssistantConfig, entityId: string, action: SmartHomeAction): Promise<CallServiceResult> {
  const domain = entityId.split(".")[0];
  if (!domain) return { ok: false, error: `"${entityId}" isn't a valid Home Assistant entity id (expected "<domain>.<object_id>", e.g. "light.living_room").` };

  let response: Response;
  let bodyText: string;
  try {
    ({ response, bodyText } = await fetchWithRetry(`${config.baseUrl}/api/services/${domain}/${action}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.token}`, "content-type": "application/json" },
      body: JSON.stringify({ entity_id: entityId }),
    }));
  } catch (err) {
    return { ok: false, error: `Failed to reach Home Assistant: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (response.ok) return { ok: true };
  let data: HomeAssistantErrorBody | undefined;
  try {
    data = JSON.parse(bodyText) as HomeAssistantErrorBody;
  } catch {
    data = undefined;
  }
  return { ok: false, error: data?.message ?? `Home Assistant API error (HTTP ${response.status})` };
}

interface GetSmartHomeStateInput {
  entity_id: string;
}

export function createGetSmartHomeStateTool(config: HomeAssistantConfig | undefined): ToolDefinition<GetSmartHomeStateInput> {
  return {
    name: "get_smart_home_state",
    description:
      "Read a Home Assistant entity's current state (e.g. a light's on/off, a sensor's reading) and its " +
      "attributes, via the real Home Assistant REST API. Requires HOME_ASSISTANT_BASE_URL/HOME_ASSISTANT_TOKEN " +
      "(a long-lived access token, created in Home Assistant's own Profile page) as environment variables.",
    riskLevel: "safe",
    inputSchema: {
      type: "object",
      properties: { entity_id: { type: "string", description: 'Entity id, e.g. "light.living_room" or "sensor.outdoor_temperature"' } },
      required: ["entity_id"],
    },
    describeCall: (input) => `get state of ${input.entity_id}`,
    async handler(input) {
      if (!config) return { content: "Home Assistant is not configured — set HOME_ASSISTANT_BASE_URL/HOME_ASSISTANT_TOKEN as environment variables to enable get_smart_home_state.", isError: true };
      const result = await getHomeAssistantEntityState(config, input.entity_id);
      if (!result.ok) return { content: result.error, isError: true };
      return { content: `${input.entity_id}: ${result.state}${Object.keys(result.attributes).length > 0 ? ` (${JSON.stringify(result.attributes)})` : ""}`, isError: false };
    },
  };
}

interface ControlSmartHomeDeviceInput {
  entity_id: string;
  action: SmartHomeAction;
}

export function createControlSmartHomeDeviceTool(config: HomeAssistantConfig | undefined): ToolDefinition<ControlSmartHomeDeviceInput> {
  return {
    name: "control_smart_home_device",
    description:
      "Turn a real Home Assistant device on/off, or toggle it (a light, switch, fan, lock, or anything else " +
      "Home Assistant controls), via the real Home Assistant REST API. Requires HOME_ASSISTANT_BASE_URL/" +
      "HOME_ASSISTANT_TOKEN as environment variables. " +
      "IMPORTANT: this changes a real physical device's real state — confirm with the user before calling this " +
      "unless they've explicitly asked for this exact action.",
    riskLevel: "ask",
    inputSchema: {
      type: "object",
      properties: {
        entity_id: { type: "string", description: 'Entity id, e.g. "light.living_room" or "switch.coffee_maker"' },
        action: { type: "string", enum: ["turn_on", "turn_off", "toggle"] },
      },
      required: ["entity_id", "action"],
    },
    describeCall: (input) => `${input.action} ${input.entity_id}`,
    async handler(input) {
      if (!config) {
        return { content: "Home Assistant is not configured — set HOME_ASSISTANT_BASE_URL/HOME_ASSISTANT_TOKEN as environment variables to enable control_smart_home_device.", isError: true };
      }
      const result = await callHomeAssistantService(config, input.entity_id, input.action);
      if (!result.ok) return { content: result.error, isError: true };
      return { content: `${input.entity_id}: ${input.action}.`, isError: false };
    },
  };
}
