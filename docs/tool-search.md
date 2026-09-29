# Tool Search

Sending every registered tool's full schema (name, description, JSON
schema) on every turn scales the request size with the *total* number of
tools available, not the number actually relevant to the task at hand. On
a small/local model this can turn a few seconds of "thinking" into
several minutes.

Tool Search closes that gap: instead of the full list, the model gets 3
small meta-tools —

| Tool | What it does |
|---|---|
| `search_tools` | Real BM25 ranking (the same scoring SQLite's own `bm25()` implements) over every available tool's name + description. Returns up to 8 matches by default. |
| `describe_tool` | The full input schema and risk level for one match. |
| `call_tool` | Actually runs it, by name and input. |

Every other tool's schema is deferred until the model actually asks for
it via `describe_tool` — the request stays small regardless of how many
tools are registered in total.

## Enabling it

On by default for **every** provider, local or cloud — not just a local
server. The problem it closes (prefill cost scaling with the *total*
number of registered tools, 188 and growing) hits a large cloud model's
input-token bill the same way it hits a small local model's latency; it's
just more visible on the local model because a slow model turns that
extra cost into minutes instead of extra tokens on the invoice. So Tool
Search stays on unless explicitly turned off:

```
/config set toolSearch false   # opt out — send every tool's full schema every turn
/config set toolSearch true    # explicit on (the default already)
```

Only an explicit `toolSearch: "false"` disables it — there's no longer a
local-vs-cloud heuristic to fall back to.

## Safety

`call_tool` is not a generic pass-through: the agent loop intercepts it
before the missing-fields check, the permission check, and the handler
dispatch, and remaps the call onto the real target tool — every one of
those applies exactly the same way a direct call to that tool would have
triggered. A "dangerous" tool called through `call_tool` still prompts
for confirmation exactly like it would otherwise. `call_tool` can also
only reach a tool this session hasn't explicitly disabled (`/tools
disable <name>`) — it's not a way to reach something that isn't
supposed to be available right now just because its schema wasn't sent.
