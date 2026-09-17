# Model providers

finanfa-code has a pluggable LLM backend. Pick one, set its environment
variables, then run (`npm run dev`, `npm run dev:web-server`, or `finanfa
--acp`). Every provider works the same way once configured — same tools,
same permissions, same UI.

| Provider | `FINANFA_PROVIDER` | Notes |
|---|---|---|
| Anthropic (default) | _(unset)_ or `anthropic` | Needs only `ANTHROPIC_API_KEY` |
| OpenAI-compatible | `openai-compatible` | Any server speaking the OpenAI chat-completions wire format — Ollama, LM Studio, llama.cpp, vLLM, Docker Model Runner, OpenRouter, Poolside, ... |
| Azure OpenAI | `azure-openai` | |
| Gemini | `gemini` | |
| Cohere | `cohere` | |
| GitHub Copilot | `github-copilot` | OAuth device flow, see below |
| Amazon Bedrock | `amazon-bedrock` | Claude via AWS |
| Google Vertex AI | `google-vertex` | Claude via GCP |

## Anthropic (default)

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npm run dev
```

## OpenAI-compatible (local or remote)

The same `openai-compatible` provider works for a **local** server on your own machine and a **remote** hosted one — only `FINANFA_BASE_URL` changes.

### Local: Ollama

```bash
ollama pull llama3.1:8b
ollama serve   # usually already running as a background service

export FINANFA_PROVIDER=openai-compatible
export FINANFA_BASE_URL=http://localhost:11434/v1
export FINANFA_MODEL=llama3.1:8b
npm run dev
```

### Local: LM Studio

Load a model in LM Studio, start its local server (Developer tab → Start Server), then:

```bash
export FINANFA_PROVIDER=openai-compatible
export FINANFA_BASE_URL=http://localhost:1234/v1
export FINANFA_MODEL=<the model id LM Studio shows>
npm run dev
```

### Local: llama.cpp / vLLM / a raw MLX server

Any server that answers `GET /v1/models` and `POST /v1/chat/completions` in the OpenAI shape works the same way — just point `FINANFA_BASE_URL` at it:

```bash
export FINANFA_PROVIDER=openai-compatible
export FINANFA_BASE_URL=http://127.0.0.1:8000/v1   # llama.cpp/vLLM's own default port, or wherever yours listens
export FINANFA_MODEL=<the model id your server reports>
npm run dev
```

`FINANFA_PROVIDER`/`FINANFA_BASE_URL` are auto-detected on session start when they're already reachable on their well-known default port (Ollama `11434`, LM Studio `1234`, llama.cpp `8080`, vLLM `8000`, Docker Model Runner `12434`) — the web UI's model picker lists what's actually running with no configuration at all.

**A local/small model gets [Tool Search](tool-search.md) automatically** — instead of every registered tool's full schema on every turn (which can make a small model's response time balloon, since prefill cost scales with the total tool count), it gets 3 small meta-tools to find and call the one it actually needs. No configuration needed; force it on/off with `/config set toolSearch true|false`.

### Local: Docker Model Runner

```bash
docker model pull ai/qwen2.5:latest
docker model run ai/qwen2.5:latest &   # starts the OpenAI-compatible gateway on :12434

export FINANFA_PROVIDER=openai-compatible
export FINANFA_BASE_URL=http://localhost:12434/engines/v1
export FINANFA_MODEL=ai/qwen2.5:latest
npm run dev
```

The `docker_models` builtin tools (`list_docker_models`, `pull_docker_model`, `search_docker_models`, `delete_docker_model`) manage this from inside a running session too.

### Remote: OpenRouter, Poolside, or any other hosted OpenAI-compatible endpoint

```bash
export FINANFA_PROVIDER=openai-compatible
export FINANFA_BASE_URL=https://openrouter.ai/api/v1
export FINANFA_MODEL=anthropic/claude-sonnet-5
export FINANFA_API_KEY=sk-or-...
npm run dev
```

Prefer a model with reliable tool-calling support — one that writes tool calls as plain text instead of a structured response won't actually be able to use any tool. `/cost` reports `$0/0 tokens` for a backend that doesn't return usage in streamed responses; that's expected, not a bug.

**A pool of keys**, rotated on failure (a community sharing one free-tier model where any single member's key can be rate-limited or run dry): `FINANFA_API_KEYS=key1,key2,key3` instead of `FINANFA_API_KEY`.

## Azure OpenAI

```bash
export FINANFA_PROVIDER=azure-openai
export FINANFA_BASE_URL=https://my-resource.openai.azure.com   # no trailing path
export FINANFA_MODEL=my-gpt4o-deployment                        # the Azure *deployment* name, not a model name
export FINANFA_API_KEY=...
npm run dev
```

## Gemini

```bash
export FINANFA_PROVIDER=gemini
export FINANFA_API_KEY=...
npm run dev
```

## Cohere

```bash
export FINANFA_PROVIDER=cohere
export FINANFA_API_KEY=...
export FINANFA_MODEL=command-r-plus-08-2024   # optional — this is the default
npm run dev
```

## GitHub Copilot

Requires a GitHub account with Copilot access. Authentication is GitHub's OAuth **device flow** (the same mechanism `gh auth login` uses) — a one-time setup, not a config value pasted in from somewhere else.

1. Request a device code:
   ```bash
   curl -s -X POST https://github.com/login/device/code \
     -H "content-type: application/json" -H "accept: application/json" \
     -d '{"client_id":"01ab8ac9400c4e429b23","scope":"read:user"}'
   ```
   This returns `device_code`, `user_code`, and `verification_uri`.
2. Open `verification_uri` in a browser and enter the `user_code` shown.
3. Poll for the access token (repeat every `interval` seconds from step 1's response until it stops returning `authorization_pending`):
   ```bash
   curl -s -X POST https://github.com/login/oauth/access_token \
     -H "content-type: application/json" -H "accept: application/json" \
     -d '{"client_id":"01ab8ac9400c4e429b23","device_code":"<device_code from step 1>","grant_type":"urn:ietf:params:oauth:grant-type:device_code"}'
   ```
   Once authorized, this returns `{"access_token": "gho_..."}`.
4. Save it:
   ```bash
   export FINANFA_PROVIDER=github-copilot
   export FINANFA_GITHUB_COPILOT_TOKEN=gho_...   # or /config set githubCopilotToken <token>
   npm run dev
   ```

This GitHub token is exchanged for a short-lived Copilot API token automatically on every turn — it's never sent to `api.githubcopilot.com` directly.

## Amazon Bedrock (Claude via AWS)

```bash
export FINANFA_PROVIDER=amazon-bedrock
export FINANFA_MODEL=anthropic.claude-sonnet-5-20250929-v1:0   # a Bedrock model ID or cross-region inference profile ARN
export AWS_REGION=us-west-2                                      # or FINANFA_AWS_REGION / /config set awsRegion
npm run dev
```

AWS credentials come from the standard AWS credential chain (`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`AWS_SESSION_TOKEN`, `~/.aws/credentials`, an instance/task role, ...) — the same way `aws` CLI commands already authenticate on this machine.

## Google Vertex AI (Claude via GCP)

```bash
export FINANFA_PROVIDER=google-vertex
export FINANFA_MODEL=claude-sonnet-5@20250929   # a Vertex publisher model ID
export FINANFA_VERTEX_REGION=us-central1
export FINANFA_VERTEX_PROJECT_ID=my-gcp-project
npm run dev
```

Auth is Google Application Default Credentials (`GOOGLE_APPLICATION_CREDENTIALS` pointing at a service account key, or `gcloud auth application-default login`).

## Persistent config

Rather than exporting env vars every time:

```
/config set provider openai-compatible
/config set baseUrl https://inference.poolside.ai/v1
/config set model poolside/laguna-s-2.1
/config set apiKey <your key>
```

Saved to `~/.finanfa-code/config.json` (global) or `.finanfa-code/config.json` (project-local, overrides global). Priority: env var/CLI flag > project config > global config > default. Takes effect on the next run.

## Vision routing

Not every model can see images. If your primary model can't, route just the turn right after a screenshot/`view_image` call to a vision-capable model instead:

```
/config set visionProvider anthropic
/config set visionModel claude-sonnet-5
/config set visionApiKey <your key>
```

(or `visionProvider openai-compatible` + `visionBaseUrl`/`visionModel`/`visionApiKey`). Every other turn still uses the primary model.
