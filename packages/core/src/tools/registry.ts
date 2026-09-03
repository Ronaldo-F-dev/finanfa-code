import type Anthropic from "@anthropic-ai/sdk";
import type { ToolDefinition } from "../core/types.js";

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered`);
    }
    this.tools.set(tool.name, tool);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  /** Removes every registered tool whose name starts with `prefix` (used to reload MCP-provided tools). */
  unregisterByPrefix(prefix: string): void {
    for (const name of this.tools.keys()) {
      if (name.startsWith(prefix)) this.tools.delete(name);
    }
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  toAnthropicToolList(): Anthropic.Tool[] {
    return this.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
    }));
  }
}
