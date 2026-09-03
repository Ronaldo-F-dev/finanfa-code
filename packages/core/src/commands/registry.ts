import type { CommandHandler } from "./types.js";

export interface CommandInfo {
  name: string;
  description: string;
}

interface RegisteredCommand extends CommandInfo {
  handler: CommandHandler;
}

export class CommandRegistry {
  private readonly commands = new Map<string, RegisteredCommand>();

  register(name: string, handler: CommandHandler, description = ""): void {
    this.commands.set(name, { name, description, handler });
  }

  get(name: string): CommandHandler | undefined {
    return this.commands.get(name)?.handler;
  }

  names(): string[] {
    return [...this.commands.keys()];
  }

  /** Name + description for every registered command, for help text and autocomplete. */
  list(): CommandInfo[] {
    return [...this.commands.values()].map(({ name, description }) => ({ name, description }));
  }
}
