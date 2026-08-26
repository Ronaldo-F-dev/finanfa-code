import Anthropic from "@anthropic-ai/sdk";
import type { AgentSession } from "./session.js";
import type { UIAdapter } from "../ui/adapter.js";

const client = new Anthropic();

export async function runTurn(
  session: AgentSession,
  ui: UIAdapter,
  userInput: string,
): Promise<void> {
  session.messages.push({ role: "user", content: userInput });

  const stream = client.messages.stream({
    model: session.model,
    max_tokens: 8192,
    system: session.systemPrompt,
    messages: session.messages,
  });

  stream.on("text", (delta) => ui.writeAssistantDelta(delta));

  const message = await stream.finalMessage();
  session.messages.push({ role: "assistant", content: message.content });
  session.recordUsage(message.usage.input_tokens, message.usage.output_tokens);

  ui.setStatus({
    tokens: session.usage.inputTokens + session.usage.outputTokens,
    costUsd: session.costUsd,
    model: session.model,
  });

  await session.persist();
}
