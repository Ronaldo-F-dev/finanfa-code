# n8n integration (POST /api/turn)

Every other way to run a turn against this agent (the browser UI, the CLI,
ACP) either speaks the WebSocket protocol at `/ws` or is a long-lived
process — none of that fits an HTTP-request-shaped tool like n8n's generic
**HTTP Request** node, which sends one request and expects one JSON
response back. `POST /api/turn` is that missing piece: it runs exactly one
real agent turn (same session construction, tools, permissions, and
provider selection as every other entry point) and blocks until it's done,
returning the final answer as plain JSON — no streaming, no WebSocket
client needed.

## Endpoint

```
POST /api/turn
Content-Type: application/json
```

### Auth

Same bearer-token gate every other `/api/*` route uses (see
[configuration.md](./configuration.md) for `FINANFA_WEB_USERS`/
`FINANFA_WEB_ACCOUNTS`/OIDC — collectively "Gateway auth"):

- Gateway auth **off** (nothing configured): the route is open, exactly
  like every other route today. This is the common case for a personal
  server calling itself from n8n on the same machine/network.
- Gateway auth **on**: every request needs `Authorization: Bearer <token>`,
  where `<token>` is one of the static `FINANFA_WEB_USERS` tokens or a
  session token from `POST /api/auth/login`. A missing/invalid token gets
  a plain `401`.

### Request body

| field       | type   | required | meaning |
|-------------|--------|----------|---------|
| `message`   | string | yes      | The prompt/user message for this turn. |
| `project`   | string | no       | Project id (see `GET /api/projects`) or omit for the default workspace — same `?project=` convention every other route uses. 404s on an unknown id rather than silently falling back. |
| `session`   | string | no       | An existing session id to resume and continue (same session file every WS connection/CLI/ACP session would resume). Omit to start a fresh session. |
| `model`     | string | no       | Overrides the model for a **new** session (ignored on resume — a session keeps whatever model it was created with, same as everywhere else in this project). |
| `effort`    | string | no       | `"low"` / `"medium"` / `"high"` — same effort-tier shortcut as the web UI's own picker (picks a model + token cap + tool budget together). Takes priority over `model` when both are set. |
| `timeoutMs` | number | no       | How long to wait before aborting the turn and returning a `408`. Default `180000` (3 minutes), clamped to a `600000` (10 minute) ceiling. |

### Response (200)

```json
{
  "sessionId": "…",
  "model": "claude-sonnet-4-5",
  "providerKind": "anthropic",
  "effort": "medium",
  "text": "the final assistant answer",
  "toolCalls": [{ "name": "read_file", "riskLevel": "safe" }],
  "deniedTools": [],
  "stoppedByStepLimitGuard": false,
  "systemMessages": [],
  "errors": []
}
```

- `effort` is only present when the session actually has an effort tier
  set (via this request's own `effort` field, or inherited from a resumed
  session) — omitted otherwise, same as the WS protocol's `session_info`.
- `text` is the final assistant message for this turn — the same text a
  WS client would build up from `assistant_delta` events.
- `toolCalls` lists every tool that actually ran.
- `deniedTools` — see **Permission prompts** below. Non-empty means at
  least one tool call was skipped because it needed a decision this
  stateless endpoint couldn't make.
- `stoppedByStepLimitGuard` — true if the turn hit the internal step-limit
  guard (a very long agentic task). Unlike the WS UI, this endpoint does
  **not** auto-continue for you — send another request with the same
  `session` id and a message like `"continue"` if you want to keep going.

### Error responses

| status | when |
|--------|------|
| `400`  | missing/empty `message`, unknown `project`, unknown `effort` level, or no default provider configured for a `"high"`-equivalent effort request. |
| `401`  | Gateway auth is on and the request has no/an invalid bearer token. |
| `403`  | `session` refers to a session owned by a different Gateway user. |
| `404`  | `project` doesn't match any known project id. |
| `408`  | the turn exceeded `timeoutMs` — it was actually aborted server-side, not just reported late. `partialText` (if any assistant text streamed before the abort) and `sessionId` are included so you can inspect or resume it. |
| `502`  | the underlying provider call failed, or an effort tier requiring a local model service failed to start. |

## Permission prompts (non-interactive policy)

A normal session can ask a live human "allow this tool call? y/n" and wait.
A REST request from n8n has no one to answer that mid-request. This
endpoint reuses this project's existing **non-interactive** permission
mode (the same mode `--non-interactive` already uses on the CLI, and the
ACP bridge always uses) instead of inventing a second mechanism:

- Any tool call that would otherwise prompt ("ask"/"dangerous" risk tier,
  no matching allow rule) is **denied automatically** — the model gets a
  normal "User declined to run this tool." result and can adapt its answer
  around that, same as if a human had typed "n".
- The tool's name is added to the response's `deniedTools` array so the
  caller can tell this happened, instead of silently trusting a final
  answer that may have skipped a step.
- A project's own `.finanfa-code/settings.json` (permission rules/hooks)
  is likewise only honored if the folder was already explicitly trusted
  interactively before — untrusted-and-ungated is the fail-safe default
  here too.

If you want a specific tool to actually run for this endpoint (e.g.
`bash`, `write_file`), add an explicit `allow` rule for it in the project's
permission config rather than relying on interactive prompting, which this
endpoint deliberately never does.

## Configuring n8n's HTTP Request node

1. Add an **HTTP Request** node.
2. **Method**: `POST`
3. **URL**: `http://<your-server>:4600/api/turn` (default port `4600`,
   or whatever `PORT` the server was started with).
4. **Authentication**: if Gateway auth is on, choose "Generic Credential
   Type" → "Header Auth", with header name `Authorization` and value
   `Bearer <your-token>`. If Gateway auth is off, leave authentication
   set to "None".
5. **Headers**: `Content-Type: application/json`.
6. **Body** (JSON):
   ```json
   {
     "message": "={{ $json.userMessage }}",
     "project": "my-project-id",
     "effort": "medium",
     "timeoutMs": 120000
   }
   ```
   (`message` is the only required field — the rest can be dropped for
   the default project/model/timeout.)
7. Downstream nodes read the reply from the response body, e.g.
   `{{ $json.text }}` for the assistant's answer, or
   `{{ $json.deniedTools }}` to branch on whether a tool call was
   skipped.

To keep a conversation going across multiple n8n executions, store the
first response's `sessionId` (e.g. in an n8n variable or a small
datastore node) and pass it back as `session` on the next call.
