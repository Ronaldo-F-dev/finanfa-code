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

Auto-enabled whenever the resolved provider points at a local server
(`localhost`/`127.0.0.1`/`::1`) — see [providers.md](providers.md). Force
it on or off regardless of provider:

```
/config set toolSearch true
/config set toolSearch false
/config set toolSearch auto   # back to the default heuristic
```

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
