import type { CommandHandler } from "./types.js";

export class CommandRegistry {
  private readonly commands = new Map<string, CommandHandler>();

  register(name: string, handler: CommandHandler): void {
    this.commands.set(name, handler);
  }

  get(name: string): CommandHandler | undefined {
    return this.commands.get(name);
  }

  names(): string[] {
    return [...this.commands.keys()];
  }
}
