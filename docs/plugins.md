# Plugin SDK

A plugin adds tools (and, in the terminal UI, slash commands) to the agent
without touching core source. This is the contract a plugin can rely on.

## Where a plugin lives

```
.finanfa-code/plugins/<name>/index.js
```

One directory per plugin, under the *project* root (there's no global
`~/.finanfa-code/plugins/` equivalent yet, unlike skills/memory/commands/
agents). `index.js` is loaded as an ES module and can export either or both:

```js
export function registerTools(registry) { ... }
export function registerCommands(commands) { ... }
```

Both are called once, at startup, before the first turn runs. A plugin
that throws while loading is skipped — logged as an error, not fatal to
the session — so one broken plugin can't take down the whole run.

## Trust

A plugin is arbitrary imported JS with full Node.js access — not inert
config. Loading is gated on the same folder-trust prompt as
`.finanfa-code/settings.json` (permission rules and hooks): the first time
either exists in a project, the user is asked whether to trust the
folder's files. Decline, and the plugins directory is ignored for that
run (global config still applies) — the folder stays untrusted next time
too. Only write or install a plugin you'd trust to run with your own
Node.js permissions, and never load one from a project you haven't
reviewed.

## `registerTools(registry)`

`registry` is a `ToolRegistry` (`packages/core/src/tools/registry.ts`).
Call `registry.register(toolDefinition)` for each tool. `register` throws
if the name is already taken, so pick something namespaced enough not to
collide with a builtin or another plugin.

### `ToolDefinition`

```ts
interface ToolDefinition<TInput = any> {
  name: string;
  description: string;
  inputSchema: JsonSchema; // JSON Schema object describing the tool's input
  riskLevel: "safe" | "ask" | "dangerous";
  handler: (input: TInput, ctx: ToolContext) => Promise<ToolResult>;
  riskKey?: (input: TInput) => string;
  describeCall?: (input: TInput) => string;
  preview?: (input: TInput, ctx: ToolContext) => Promise<string>;
}
```

- **`riskLevel`** drives the permission system: `"safe"` runs without a
  prompt, `"ask"` prompts (unless already allowed for this session/
  project), `"dangerous"` always prompts and is never eligible for
  session-wide "always allow". Pick honestly — this is the only thing
  standing between a user and an action they didn't expect.
- **`riskKey(input)`** lets "always allow" scope narrower than the whole
  tool (e.g. a bash tool keying on the command prefix). Defaults to the
  tool name.
- **`describeCall(input)`** is the one-line summary shown in the
  permission prompt itself — write one if the raw JSON input wouldn't be
  self-explanatory.
- **`preview(input, ctx)`** can return a richer string (e.g. a diff) shown
  above the prompt for an `"ask"`/`"dangerous"` tool.
- **`handler(input, ctx)`** does the work and returns a `ToolResult`:

```ts
interface ToolResult {
  content: string;
  isError: boolean;
  metadata?: Record<string, unknown>;
  images?: ToolImage[]; // shown to the model as a follow-up multimodal message
  media?: { kind: "audio" | "image"; path: string; mimeType: string }; // shown to the human in the UI
}
```

`ctx` (`ToolContext`) gives you `cwd`, `sessionId`, an `AbortSignal`, and a
few optional session-scoped collaborators (`history` for `/undo`,
`todos`, `fileFreshness`, `ui`, `exitPlanMode`) — present when the real
agent loop calls your tool, `undefined` in a bare unit test that doesn't
wire them up.

### Example

```js
// .finanfa-code/plugins/weather/index.js
export function registerTools(registry) {
  registry.register({
    name: "weather_lookup",
    description: "Looks up the current weather for a city.",
    riskLevel: "safe",
    inputSchema: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
    describeCall: (input) => `Look up weather for ${input.city}`,
    async handler(input) {
      const res = await fetch(`https://example-weather-api.test/v1/current?city=${encodeURIComponent(input.city)}`);
      if (!res.ok) return { content: `Lookup failed: ${res.status}`, isError: true };
      const data = await res.json();
      return { content: `${input.city}: ${data.tempC}°C, ${data.condition}`, isError: false };
    },
  });
}
```

## `registerCommands(commands)`

`commands` is a `CommandRegistry` (`packages/core/src/commands/registry.ts`).
Call `commands.register(name, handler, description)` to add a `/name`
slash command.

```ts
type CommandHandler = (ctx: CommandContext) => Promise<"continue" | "exit"> | "continue" | "exit";

interface CommandContext {
  session: AgentSession;
  ui: UIAdapter;
  tools: ToolRegistry;
  permissions: PermissionManager;
  mcp: McpClientManager;
  provider: LlmProvider;
  cwd: string;
  args: string; // raw text after "/name "
  setSession: (session: AgentSession) => void;
  customCommands?: Map<string, CustomCommand>;
}
```

Return `"exit"` to end the REPL (like the builtin `/exit`), `"continue"`
otherwise. A command can't override a builtin of the same name — builtins
always win on a collision, so a same-named plugin command is silently
shadowed.

**Current limitation:** the browser UI has no slash-command surface yet,
so `registerCommands` only has an effect in the terminal (`finanfa-code`
CLI). It's still safe to define — the web server just never calls it —
but don't rely on a plugin's commands being reachable from the browser.

## Directory plugins and marketplaces

Besides code plugins (`index.js`, above), a plugin can be a plain folder
that contributes content — no code to trust beyond the hooks it ships:

```
my-plugin/
  plugin.json          optional: { "name", "version", "description" }
  commands/*.md        slash commands (same format as .finanfa-code/commands)
  agents/*.md          subagent types (same format as .finanfa-code/agents)
  skills/*.md          skills (same format as .finanfa-code/skills)
  hooks/hooks.json     { "hooks": { "<event>": [{ "matcher"?, "hooks": [...] }] } }
```

`${FINANFA_PLUGIN_ROOT}` inside a hook command expands to the plugin's
folder, so a hook can ship and call its own scripts. Installed plugins
live in `~/.finanfa-code/plugins/<name>/`; a project can also carry its own
under `.finanfa-code/plugins/` (its hooks only run once the project is
trusted). Anything the user wrote themselves wins a name collision with a
plugin's, and a user's hooks are consulted before a plugin's.

A **marketplace** is a git repo or local folder with a `marketplace.json`
(`{ "name", "plugins": [{ "name", "description"?, "source" }] }`, where
`source` is a path inside the marketplace, a git URL, or
`{ "source": "git", "url" }`).

```
/plugin marketplace add <git-url|dir>
/plugin search [text]
/plugin install <plugin>[@<marketplace>]
/plugin list | enable <p> | disable <p> | remove <p>
/plugin test <dir>          # validate a plugin folder
```

`install`, `remove`, `enable`, `disable` and `/plugin reload` re-read hooks
and slash commands immediately. A plugin's **subagent types and skills** are
bound at startup, so they need a restart. Review a plugin before installing
it — its hooks run shell commands.

## What plugins can't do (yet)

- **No provider/channel plugins.** `LlmProvider` implementations
  (Anthropic, OpenAI-compatible, Azure OpenAI, Gemini) are selected by
  `selectProvider` in `packages/core/src/app.ts` and aren't
  plugin-loadable — adding a new backend today means adding a provider
  class in core, not dropping a file in `.finanfa-code/plugins/`.
- **No compatibility checking.** A code plugin is just a directory name
  and an `index.js`; `plugin.json` carries a version and description but
  nothing checks it against the host's API surface. If you're
  publishing a plugin for others to install, document its expected
  `ToolDefinition`/`CommandHandler` shape yourself for now.
- **No sandboxing.** A plugin runs with the same Node.js process
  permissions as the agent itself — the folder-trust prompt above is the
  only gate, not a capability boundary.

If you need a capability outside this contract (a new LLM backend, a
messaging channel, a signed/versioned package format), that's core
surgery today, not a plugin — worth raising as an issue rather than
routing around it.
