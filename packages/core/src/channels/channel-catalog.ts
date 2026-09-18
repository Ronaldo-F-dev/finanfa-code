/**
 * The web UI's own catalog of every chat channel this project supports —
 * one entry per registerXChannelRoutes in @finanfa/web-server, describing
 * exactly which environment variables it reads (see docs/channels.md,
 * which this mirrors) so a settings screen can render a real form and the
 * server can report per-field configured/overridden-by-env status without
 * either side hardcoding the other's channel list twice.
 */
export interface ChannelFieldDef {
  /** The real environment variable this field maps to (see the channel's own channels-*.ts / send-*-message.ts for where it's read). */
  key: string;
  label: string;
  secret?: boolean;
  placeholder?: string;
}

export interface ChannelDef {
  id: string;
  name: string;
  fields: ChannelFieldDef[];
  /** Shown as a ready-to-paste webhook/endpoint URL once the server's own public base URL is known. */
  webhookPaths?: { label: string; path: string }[];
  setupNote: string;
}

export const CHANNEL_CATALOG: ChannelDef[] = [
  {
    id: "slack",
    name: "Slack",
    fields: [
      { key: "SLACK_SIGNING_SECRET", label: "Signing Secret", secret: true, placeholder: "from the app's Basic Information page" },
      { key: "SLACK_BOT_TOKEN", label: "Bot Token", secret: true, placeholder: "xoxb-…" },
    ],
    webhookPaths: [{ label: "Event Subscriptions Request URL", path: "/api/channels/slack/events" }],
    setupNote: "Enable Event Subscriptions with the URL below, subscribe to message.channels and/or app_mention, then invite the bot to a channel.",
  },
  {
    id: "telegram",
    name: "Telegram",
    fields: [
      { key: "TELEGRAM_BOT_TOKEN", label: "Bot Token", secret: true, placeholder: "from @BotFather" },
      { key: "TELEGRAM_WEBHOOK_SECRET", label: "Webhook Secret", secret: true, placeholder: "any string you pick" },
    ],
    webhookPaths: [{ label: "Webhook URL", path: "/api/channels/telegram/webhook" }],
    setupNote: "After saving, register the webhook once with Telegram's setWebhook API using the URL below and your webhook secret.",
  },
  {
    id: "discord",
    name: "Discord",
    fields: [
      { key: "DISCORD_PUBLIC_KEY", label: "Public Key", placeholder: "from General Information" },
      { key: "DISCORD_APPLICATION_ID", label: "Application ID", placeholder: "from General Information" },
      { key: "DISCORD_BOT_TOKEN", label: "Bot Token", secret: true, placeholder: "from the Bot tab" },
    ],
    webhookPaths: [{ label: "Interactions Endpoint URL", path: "/api/channels/discord/interactions" }],
    setupNote: "Set the Interactions Endpoint URL below in General Information, then register the /ask command.",
  },
  {
    id: "matrix",
    name: "Matrix",
    fields: [
      { key: "MATRIX_HOMESERVER_URL", label: "Homeserver URL", placeholder: "https://matrix.example.org" },
      { key: "MATRIX_AS_TOKEN", label: "Application Service Token", secret: true },
      { key: "MATRIX_HS_TOKEN", label: "Homeserver Token", secret: true },
      { key: "MATRIX_BOT_USER_ID", label: "Bot User ID", placeholder: "@finanfa-bot:example.org" },
    ],
    webhookPaths: [{ label: "Application Service transactions URL", path: "/api/channels/matrix/transactions" }],
    setupNote: "Register this as an Application Service on your homeserver (e.g. Synapse's app_service_config_files) using the values below.",
  },
  {
    id: "line",
    name: "LINE",
    fields: [
      { key: "LINE_CHANNEL_SECRET", label: "Channel Secret", secret: true },
      { key: "LINE_CHANNEL_ACCESS_TOKEN", label: "Channel Access Token", secret: true },
    ],
    webhookPaths: [{ label: "Webhook URL", path: "/api/channels/line/webhook" }],
    setupNote: "In the LINE Developers Console's Messaging API tab, set the Webhook URL below and enable \"Use webhook\".",
  },
  {
    id: "feishu",
    name: "Feishu / Lark",
    fields: [
      { key: "FEISHU_VERIFICATION_TOKEN", label: "Verification Token", secret: true },
      { key: "FEISHU_APP_ID", label: "App ID", placeholder: "cli_…" },
      { key: "FEISHU_APP_SECRET", label: "App Secret", secret: true },
    ],
    webhookPaths: [{ label: "Request URL", path: "/api/channels/feishu/webhook" }],
    setupNote: "On the app's Event Subscriptions page, set the Request URL below and subscribe to im.message.receive_v1.",
  },
  {
    id: "teams",
    name: "Microsoft Teams",
    fields: [
      { key: "MICROSOFT_APP_ID", label: "App ID", placeholder: "the bot's Azure Bot resource App ID" },
      { key: "MICROSOFT_APP_PASSWORD", label: "App Password", secret: true },
    ],
    webhookPaths: [{ label: "Messaging endpoint", path: "/api/channels/teams/webhook" }],
    setupNote: "On the Azure Bot resource's Configuration page, set the Messaging endpoint below and enable the Teams channel.",
  },
  {
    id: "whatsapp",
    name: "WhatsApp",
    fields: [
      { key: "WHATSAPP_APP_SECRET", label: "App Secret", secret: true },
      { key: "WHATSAPP_VERIFY_TOKEN", label: "Verify Token", secret: true, placeholder: "any string you pick" },
      { key: "WHATSAPP_ACCESS_TOKEN", label: "Access Token", secret: true },
      { key: "WHATSAPP_PHONE_NUMBER_ID", label: "Phone Number ID", placeholder: "not the phone number itself" },
    ],
    webhookPaths: [{ label: "Callback URL", path: "/api/channels/whatsapp/webhook" }],
    setupNote: "Set the Callback URL below and the Verify Token above, then subscribe the app to the messages webhook field.",
  },
  {
    id: "twilio",
    name: "Twilio (SMS & Voice)",
    fields: [
      { key: "TWILIO_ACCOUNT_SID", label: "Account SID", placeholder: "AC…" },
      { key: "TWILIO_AUTH_TOKEN", label: "Auth Token", secret: true },
      { key: "TWILIO_FROM_NUMBER", label: "From Number", placeholder: "+1… (E.164 format)" },
    ],
    webhookPaths: [
      { label: "SMS: \"A message comes in\"", path: "/api/channels/sms/webhook" },
      { label: "Voice: \"A call comes in\"", path: "/api/channels/voice/webhook" },
    ],
    setupNote: "On that number's Configure page, point the two webhooks below at their matching fields.",
  },
];
