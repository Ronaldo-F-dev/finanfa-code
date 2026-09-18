# Channels

Besides the terminal, browser, and VS Code UIs, the web server can be
reached from outside as a chat bot on any of these platforms — an
inbound message runs one real agent turn (same tools/permissions as
everywhere else) and gets a reply posted back. Every channel here 404s
until its own environment variables are set — there's no unauthenticated
middle state.

Every field below can also be set from the web UI's own **Channels**
panel (sidebar → 📡 Channels) instead of exporting environment variables
by hand — it saves to the server's global config and applies immediately,
no restart needed, unless a real environment variable for that exact
field is already set (which always wins, same precedence as the rest of
this project's config).

Every webhook-based channel here needs a real public HTTPS URL, which
`localhost` obviously isn't. Set `FINANFA_TUNNEL=1` (requires
[`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
on PATH, e.g. `brew install cloudflared` on macOS — not auto-installed)
to have the server open a real cloudflared "quick tunnel" on startup and
use its public URL for every webhook URL shown in the Channels panel —
no more running `cloudflared` by hand in a separate terminal.

## Slack

```bash
export SLACK_SIGNING_SECRET=...   # from your Slack app's "Basic Information" page
export SLACK_BOT_TOKEN=xoxb-...   # from "OAuth & Permissions", needs the chat:write scope
npm run dev:web-server
```

1. **Event Subscriptions** → enable, Request URL = `https://<your-server>/api/channels/slack/events` (Slack verifies this itself via the handshake the endpoint answers).
2. Subscribe to the `message.channels` and/or `app_mention` bot events.
3. Invite the bot to a channel and message it (or @-mention it) — each thread maps to its own persistent session.

## Telegram

```bash
export TELEGRAM_BOT_TOKEN=123456:...       # from @BotFather
export TELEGRAM_WEBHOOK_SECRET=...         # any string you pick
npm run dev:web-server
```

Register the webhook once:

```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=https://<your-server>/api/channels/telegram/webhook&secret_token=<TELEGRAM_WEBHOOK_SECRET>"
```

Message the bot directly, or in a group it's been added to — each chat
(or forum topic, in a topics-enabled supergroup) maps to its own
persistent session.

A tool call needing confirmation (e.g. `bash`) sends the question back
into the same chat with real tappable Yes/No/Always buttons — reply with
a button tap, or just type `y`/`n`/`a`/`t`, either works. Without this,
every such call is auto-denied (the default for every other channel that
hasn't wired this up yet). A confirmation left unanswered for 5 minutes
is treated as "no".

## Matrix

A real [Application Service](https://spec.matrix.org/latest/application-service-api/)
— works against any homeserver (Synapse, Dendrite, Conduit), since Matrix
is a federated, open protocol, not a single vendor's API.

```bash
export MATRIX_HOMESERVER_URL=https://matrix.example.org   # your homeserver's own base URL
export MATRIX_AS_TOKEN=...           # this AS's own token — authenticates its outbound API calls
export MATRIX_HS_TOKEN=...           # a separate token the homeserver authenticates its pushes to us with
export MATRIX_BOT_USER_ID=@finanfa-bot:example.org
npm run dev:web-server
```

Register the Application Service on your homeserver (e.g. Synapse's
`app_service_config_files`):

```yaml
id: finanfa-code
url: https://<your-server>/api/channels/matrix/transactions
as_token: "<MATRIX_AS_TOKEN>"
hs_token: "<MATRIX_HS_TOKEN>"
sender_localpart: finanfa-bot
namespaces:
  users: [{ exclusive: true, regex: "@finanfa-bot:example\\.org" }]
  rooms: []
  aliases: []
```

Invite the bot's user id to a room (or have it join one) — each room maps
to its own persistent session.

## LINE

```bash
export LINE_CHANNEL_SECRET=...         # from the LINE Developers Console → your channel's Basic settings
export LINE_CHANNEL_ACCESS_TOKEN=...   # same console, Messaging API tab
npm run dev:web-server
```

In the LINE Developers Console's Messaging API tab, set the **Webhook
URL** to `https://<your-server>/api/channels/line/webhook` and enable
"Use webhook". Message the bot directly, or in a group/room it's been
added to — each user/group/room maps to its own persistent session.

## Feishu / Lark

```bash
export FEISHU_VERIFICATION_TOKEN=...   # from your app's Event Subscriptions page
export FEISHU_APP_ID=cli_...           # from the app's Credentials & Basic Info page
export FEISHU_APP_SECRET=...           # same page
npm run dev:web-server
```

On your app's Event Subscriptions page, set the **Request URL** to
`https://<your-server>/api/channels/feishu/webhook` and subscribe to the
`im.message.receive_v1` event. Message the bot directly, or in a group
it's been added to — each chat maps to its own persistent session.

Note: only Feishu's Verification-Token auth is implemented; the optional
"Encrypt Key" mode that AES-encrypts the whole event payload isn't.

## Microsoft Teams

A real [Bot Framework](https://learn.microsoft.com/en-us/azure/bot-service/rest-api/bot-framework-rest-connector-authentication)
bot, registered as an Azure Bot resource.

```bash
export MICROSOFT_APP_ID=...          # the bot's Microsoft App ID, from its Azure Bot resource
export MICROSOFT_APP_PASSWORD=...    # a client secret for that same app registration
npm run dev:web-server
```

On the Azure Bot resource's **Configuration** page, set the **Messaging
endpoint** to `https://<your-server>/api/channels/teams/webhook`, and
enable the Teams channel. Message the bot directly, or @-mention it in a
channel it's been added to — each conversation maps to its own
persistent session.

## Discord

Discord's webhook model only delivers interactions (slash commands), not
plain channel messages, so this registers one command, `/ask`:

```bash
export DISCORD_PUBLIC_KEY=...        # your app's "Public Key", from the Discord Developer Portal
export DISCORD_APPLICATION_ID=...    # same page
export DISCORD_BOT_TOKEN=...         # only needed for send_discord_message, not the channel itself
npm run dev:web-server
```

1. **General Information** → set **Interactions Endpoint URL** to `https://<your-server>/api/channels/discord/interactions`.
2. Register the `/ask` command once:
   ```bash
   curl -X PUT "https://discord.com/api/v10/applications/<DISCORD_APPLICATION_ID>/commands" \
     -H "Authorization: Bot <DISCORD_BOT_TOKEN>" -H "content-type: application/json" \
     -d '[{"name":"ask","description":"Ask the agent something","options":[{"name":"message","description":"Your message","type":3,"required":true},{"name":"image","description":"An image to include","type":11,"required":false}]}]'
   ```
3. Invite the bot to a server and run `/ask message:<your question>` in any channel — each channel maps to its own persistent session. Attaching an image via the `image` option routes the turn through the project's configured vision model.

A tool call needing confirmation (e.g. `bash`) is posted back into the
same channel as a real followup message with tappable Yes/No/Always
buttons. A confirmation left unanswered for 5 minutes is treated as "no".

## WhatsApp

Uses the [WhatsApp Cloud API](https://developers.facebook.com/docs/whatsapp/cloud-api)
(a Meta developer app + a WhatsApp Business phone number, not a personal
WhatsApp account):

```bash
export WHATSAPP_APP_SECRET=...          # your Meta app's "App Secret", from App Settings → Basic
export WHATSAPP_VERIFY_TOKEN=...        # any string you pick
export WHATSAPP_ACCESS_TOKEN=...        # a token for the WhatsApp Business Account
export WHATSAPP_PHONE_NUMBER_ID=...     # the sending number's id, not the phone number itself
npm run dev:web-server
```

1. Set **Callback URL** to `https://<your-server>/api/channels/whatsapp/webhook` and **Verify Token** to `WHATSAPP_VERIFY_TOKEN`.
2. Subscribe the app to the `messages` webhook field.
3. Message the connected number — each sender's phone number maps to its own persistent session.

Only plain text messages are handled today; media/location/interactive-reply messages are ignored.

## SMS

Uses [Twilio](https://www.twilio.com/docs/usage/security#validating-requests)'s Programmable Messaging API:

```bash
export TWILIO_ACCOUNT_SID=AC...      # from the Twilio Console dashboard
export TWILIO_AUTH_TOKEN=...         # also what verifies inbound webhook requests
export TWILIO_FROM_NUMBER=+1...      # your Twilio phone number, E.164 format
npm run dev:web-server
```

On that number's **Configure** page, set **"A message comes in"** to
`https://<your-server>/api/channels/sms/webhook`. `TWILIO_WEBHOOK_URL`
overrides the URL Twilio's signature is checked against, if the server
sits behind something that changes what it sees as its own host/protocol.

## Voice

Uses the same Twilio account/`TWILIO_AUTH_TOKEN` as SMS — Programmable
Voice, not Messaging:

```bash
export TWILIO_AUTH_TOKEN=...
npm run dev:web-server
```

Set **"A call comes in"** to `https://<your-server>/api/channels/voice/webhook`.
A turn is raced against an 8s deadline (the caller is on hold waiting for
the response): within it, the caller hears the real reply and
`<Gather input="speech">` loops back for a follow-up; past it, the caller
is told honestly instead of sitting on hold, and — if
`TWILIO_ACCOUNT_SID`/`TWILIO_FROM_NUMBER` are also configured — texted the
answer once the turn finishes. Each call gets its own session, keyed by
Twilio's own CallSid.
