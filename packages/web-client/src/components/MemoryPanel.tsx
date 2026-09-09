import { useEffect, useState } from "react";
import { useLanguage } from "../i18n/LanguageContext";

type Scope = "project" | "global";

interface Skill {
  name: string;
  description: string;
  content: string;
  scope: Scope;
}

interface Memory {
  name: string;
  description: string;
  type: string;
  content: string;
  scope: Scope;
}

const MEMORY_TYPES = ["user", "feedback", "project", "reference"];

interface DraftBase {
  name: string;
  description: string;
  content: string;
  scope: Scope;
}

export function MemoryPanel({ projectId, onClose }: { projectId: string | undefined; onClose: () => void }) {
  const { t } = useLanguage();
  const [skills, setSkills] = useState<Skill[]>([]);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [skillDraft, setSkillDraft] = useState<DraftBase | null>(null);
  const [memoryDraft, setMemoryDraft] = useState<(DraftBase & { type: string }) | null>(null);

  const qs = projectId ? `?project=${encodeURIComponent(projectId)}` : "";

  function refresh() {
    fetch(`/api/skills${qs}`)
      .then((r) => r.json())
      .then((data: { skills: Skill[] }) => setSkills(data.skills));
    fetch(`/api/memory${qs}`)
      .then((r) => r.json())
      .then((data: { memories: Memory[] }) => setMemories(data.memories));
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(refresh, [projectId]);

  function toggle(key: string) {
    setExpanded((e) => (e === key ? null : key));
  }

  function scopeQs(scope: Scope) {
    const parts = [`scope=${scope}`];
    if (projectId) parts.push(`project=${encodeURIComponent(projectId)}`);
    return `?${parts.join("&")}`;
  }

  async function saveSkill() {
    if (!skillDraft || !skillDraft.name.trim() || !skillDraft.content.trim()) return;
    await fetch(`/api/skills${qs}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(skillDraft),
    });
    setSkillDraft(null);
    refresh();
  }

  async function deleteSkillEntry(s: Skill) {
    await fetch(`/api/skills/${encodeURIComponent(s.name)}${scopeQs(s.scope)}`, { method: "DELETE" });
    refresh();
  }

  async function saveMemory() {
    if (!memoryDraft || !memoryDraft.name.trim() || !memoryDraft.content.trim()) return;
    await fetch(`/api/memory${qs}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(memoryDraft),
    });
    setMemoryDraft(null);
    refresh();
  }

  async function deleteMemoryEntry(m: Memory) {
    await fetch(`/api/memory/${encodeURIComponent(m.name)}${scopeQs(m.scope)}`, { method: "DELETE" });
    refresh();
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal panel-modal" onClick={(e) => e.stopPropagation()}>
        <div className="panel-header">
          <span className="panel-header-icon">🧠</span>
          <span className="panel-header-title">{t("memory.title")}</span>
          <button className="panel-header-close" onClick={onClose} aria-label={t("settings.close")}>
            ×
          </button>
        </div>
        <p className="settings-hint">{t("memory.hint")}</p>

        <div className="side-panel-title">
          {t("memory.memoryCount", { count: memories.length })}
          <button className="settings-toggle memory-add-btn" onClick={() => setMemoryDraft({ name: "", description: "", content: "", scope: "project", type: "user" })}>
            {t("memory.new")}
          </button>
        </div>
        <div className="mcp-list">
          {memories.map((m) => (
            <div className="mcp-row memory-row" key={m.name}>
              <div className="mcp-row-main" onClick={() => toggle(`m-${m.name}`)}>
                <div>
                  <div className="mcp-name">
                    {m.name} <span className="memory-type">{m.type}</span> <span className="memory-scope">{m.scope}</span>
                  </div>
                  <div className="mcp-meta">{m.description}</div>
                  {expanded === `m-${m.name}` && <pre className="memory-content">{m.content}</pre>}
                </div>
              </div>
              <div className="mcp-row-actions">
                <button className="btn btn-ghost" onClick={() => setMemoryDraft({ name: m.name, description: m.description, content: m.content, scope: m.scope, type: m.type })}>
                  {t("memory.edit")}
                </button>
                <button className="btn btn-deny" onClick={() => deleteMemoryEntry(m)}>
                  {t("memory.delete")}
                </button>
              </div>
            </div>
          ))}
          {memories.length === 0 && <div className="sidebar-empty">{t("memory.nothingSaved")}</div>}
        </div>

        {memoryDraft && (
          <div className="provider-card">
            <label className="settings-field">
              <span>{t("memory.nameSlug")}</span>
              <input type="text" value={memoryDraft.name} onChange={(e) => setMemoryDraft((d) => d && { ...d, name: e.target.value })} />
            </label>
            <label className="settings-field">
              <span>{t("memory.description")}</span>
              <input type="text" value={memoryDraft.description} onChange={(e) => setMemoryDraft((d) => d && { ...d, description: e.target.value })} />
            </label>
            <div className="draft-row">
              <label className="settings-field">
                <span>{t("memory.type")}</span>
                <select value={memoryDraft.type} onChange={(e) => setMemoryDraft((d) => d && { ...d, type: e.target.value })}>
                  {MEMORY_TYPES.map((mt) => (
                    <option key={mt} value={mt}>
                      {mt}
                    </option>
                  ))}
                </select>
              </label>
              <label className="settings-field">
                <span>{t("memory.scope")}</span>
                <select value={memoryDraft.scope} onChange={(e) => setMemoryDraft((d) => d && { ...d, scope: e.target.value as Scope })}>
                  <option value="project">{t("memory.scopeProject")}</option>
                  <option value="global">{t("memory.scopeGlobal")}</option>
                </select>
              </label>
            </div>
            <label className="settings-field">
              <span>{t("memory.content")}</span>
              <textarea className="instructions-textarea" value={memoryDraft.content} onChange={(e) => setMemoryDraft((d) => d && { ...d, content: e.target.value })} />
            </label>
            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={() => setMemoryDraft(null)}>
                {t("memory.cancel")}
              </button>
              <button className="btn btn-allow" onClick={saveMemory}>
                {t("memory.saveMemory")}
              </button>
            </div>
          </div>
        )}

        <div className="side-panel-title">
          {t("memory.skillsCount", { count: skills.length })}
          <button className="settings-toggle memory-add-btn" onClick={() => setSkillDraft({ name: "", description: "", content: "", scope: "project" })}>
            {t("memory.new")}
          </button>
        </div>
        <div className="mcp-list">
          {skills.map((s) => (
            <div className="mcp-row memory-row" key={s.name}>
              <div className="mcp-row-main" onClick={() => toggle(`s-${s.name}`)}>
                <div>
                  <div className="mcp-name">
                    {s.name} <span className="memory-scope">{s.scope}</span>
                  </div>
                  <div className="mcp-meta">{s.description}</div>
                  {expanded === `s-${s.name}` && <pre className="memory-content">{s.content}</pre>}
                </div>
              </div>
              <div className="mcp-row-actions">
                <button className="btn btn-ghost" onClick={() => setSkillDraft({ name: s.name, description: s.description, content: s.content, scope: s.scope })}>
                  {t("memory.edit")}
                </button>
                <button className="btn btn-deny" onClick={() => deleteSkillEntry(s)}>
                  {t("memory.delete")}
                </button>
              </div>
            </div>
          ))}
          {skills.length === 0 && <div className="sidebar-empty">{t("memory.noSkills")}</div>}
        </div>

        {skillDraft && (
          <div className="provider-card">
            <label className="settings-field">
              <span>{t("memory.nameSlug")}</span>
              <input type="text" value={skillDraft.name} onChange={(e) => setSkillDraft((d) => d && { ...d, name: e.target.value })} />
            </label>
            <label className="settings-field">
              <span>{t("memory.description")}</span>
              <input type="text" value={skillDraft.description} onChange={(e) => setSkillDraft((d) => d && { ...d, description: e.target.value })} />
            </label>
            <label className="settings-field">
              <span>{t("memory.scope")}</span>
              <select value={skillDraft.scope} onChange={(e) => setSkillDraft((d) => d && { ...d, scope: e.target.value as Scope })}>
                <option value="project">{t("memory.scopeProject")}</option>
                <option value="global">{t("memory.scopeGlobal")}</option>
              </select>
            </label>
            <label className="settings-field">
              <span>{t("memory.contentMarkdown")}</span>
              <textarea className="instructions-textarea" value={skillDraft.content} onChange={(e) => setSkillDraft((d) => d && { ...d, content: e.target.value })} />
            </label>
            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={() => setSkillDraft(null)}>
                {t("memory.cancel")}
              </button>
              <button className="btn btn-allow" onClick={saveSkill}>
                {t("memory.saveSkill")}
              </button>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
