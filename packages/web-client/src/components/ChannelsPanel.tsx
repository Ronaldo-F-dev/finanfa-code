import { useEffect, useState } from "react";
import { useLanguage } from "../i18n/LanguageContext";

interface ChannelField {
  key: string;
  label: string;
  secret: boolean;
  placeholder?: string;
  configured: boolean;
  envOverride: boolean;
}

interface ChannelStatus {
  id: string;
  name: string;
  setupNote: string;
  webhookPaths?: { label: string; url: string }[];
  fields: ChannelField[];
  configured: boolean;
}

async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Clipboard access can be denied (permissions, non-HTTPS context) —
    // the URL is still shown in the input for a manual copy either way.
  }
}

function ChannelCard({ channel, onSaved }: { channel: ChannelStatus; onSaved: () => void }) {
  const { t } = useLanguage();
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<string | null>(null);
  const [registering, setRegistering] = useState(false);

  async function handleSave() {
    setStatus(t("channels.saving"));
    const res = await fetch(`/api/channels-config/${channel.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(draft),
    });
    setStatus(res.ok ? t("channels.saved") : t("channels.saveFailed"));
    setDraft({});
    onSaved();
  }

  async function handleRegisterDiscordCommand() {
    setRegistering(true);
    setStatus(null);
    try {
      const res = await fetch("/api/channels-config/discord/register-command", { method: "POST" });
      const data = await res.json();
      setStatus(res.ok ? t("channels.discordCommandRegistered") : (data.error ?? t("channels.saveFailed")));
    } finally {
      setRegistering(false);
    }
  }

  return (
    <div className="project-card channel-card" onClick={() => setExpanded((v) => !v)}>
      <div className="channel-card-header">
        <div className="channel-card-name">{channel.name}</div>
        <span className={`channel-status-pill ${channel.configured ? "channel-status-on" : "channel-status-off"}`}>
          {channel.configured ? t("channels.configured") : t("channels.notConfigured")}
        </span>
      </div>

      {expanded && (
        <div className="channel-card-body" onClick={(e) => e.stopPropagation()}>
          <p className="settings-hint">{channel.setupNote}</p>

          {channel.fields.map((f) => (
            <label className="settings-field" key={f.key}>
              <span>
                {f.label}
                {f.envOverride && <span className="provider-badge channel-env-badge">{t("channels.envOverride")}</span>}
              </span>
              <input
                type={f.secret ? "password" : "text"}
                placeholder={f.configured ? t("channels.savedPlaceholder") : f.placeholder}
                value={draft[f.key] ?? ""}
                disabled={f.envOverride}
                onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
              />
            </label>
          ))}

          <button className="btn btn-allow" onClick={handleSave}>
            {t("channels.save")}
          </button>

          {channel.webhookPaths?.map((w) => (
            <label className="settings-field channel-webhook-row" key={w.url}>
              <span>{w.label}</span>
              <div className="provider-card-row">
                <input type="text" readOnly value={w.url} onClick={(e) => (e.target as HTMLInputElement).select()} />
                <button className="btn btn-ghost" onClick={() => copyToClipboard(w.url)}>
                  {t("channels.copy")}
                </button>
              </div>
            </label>
          ))}

          {channel.id === "discord" && (
            <button className="btn btn-ghost" onClick={handleRegisterDiscordCommand} disabled={registering}>
              {registering ? t("channels.registering") : t("channels.registerDiscordCommand")}
            </button>
          )}

          {status && <div className="settings-status">{status}</div>}
        </div>
      )}
    </div>
  );
}

export function ChannelsPanel({ onClose }: { onClose: () => void }) {
  const { t } = useLanguage();
  const [channels, setChannels] = useState<ChannelStatus[]>([]);
  const [tunnelUrl, setTunnelUrl] = useState<string | undefined>(undefined);

  function refresh() {
    fetch("/api/channels-config")
      .then((r) => r.json())
      .then((data: { channels: ChannelStatus[] }) => setChannels(data.channels))
      .catch(() => setChannels([]));
    fetch("/api/tunnel-url")
      .then((r) => r.json())
      .then((data: { url?: string }) => setTunnelUrl(data.url))
      .catch(() => setTunnelUrl(undefined));
  }

  useEffect(refresh, []);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal panel-modal channels-panel" onClick={(e) => e.stopPropagation()}>
        <div className="panel-header">
          <span className="panel-header-icon">📡</span>
          <span className="panel-header-title">{t("channels.title")}</span>
          <button className="panel-header-close" onClick={onClose} aria-label={t("settings.close")}>
            ×
          </button>
        </div>
        <p className="settings-hint">{t("channels.hint")}</p>
        <p className="settings-hint">{tunnelUrl ? t("channels.tunnelOn", { url: tunnelUrl }) : t("channels.tunnelOff")}</p>

        <div className="project-grid channels-grid">
          {channels.map((c) => (
            <ChannelCard key={c.id} channel={c} onSaved={refresh} />
          ))}
        </div>

        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onClose}>
            {t("settings.close")}
          </button>
        </div>
      </div>
    </div>
  );
}
