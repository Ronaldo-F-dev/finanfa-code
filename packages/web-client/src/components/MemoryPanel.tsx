import { useEffect, useState } from "react";

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
      <div className="modal mcp-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">Memory & skills</div>
        <p className="settings-hint">
          Global entries apply to every project on this machine — this is where your own personal notes and tools live. Project entries only apply
          here.
        </p>

        <div className="side-panel-title">
          Memory ({memories.length})
          <button className="settings-toggle memory-add-btn" onClick={() => setMemoryDraft({ name: "", description: "", content: "", scope: "project", type: "user" })}>
            + New
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
                  Edit
                </button>
                <button className="btn btn-deny" onClick={() => deleteMemoryEntry(m)}>
                  Delete
                </button>
              </div>
            </div>
          ))}
          {memories.length === 0 && <div className="sidebar-empty">Nothing saved yet.</div>}
        </div>

        {memoryDraft && (
          <div className="provider-card">
            <label className="settings-field">
              <span>Name (slug)</span>
              <input type="text" value={memoryDraft.name} onChange={(e) => setMemoryDraft((d) => d && { ...d, name: e.target.value })} />
            </label>
            <label className="settings-field">
              <span>Description</span>
              <input type="text" value={memoryDraft.description} onChange={(e) => setMemoryDraft((d) => d && { ...d, description: e.target.value })} />
            </label>
            <div className="draft-row">
              <label className="settings-field">
                <span>Type</span>
                <select value={memoryDraft.type} onChange={(e) => setMemoryDraft((d) => d && { ...d, type: e.target.value })}>
                  {MEMORY_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </label>
              <label className="settings-field">
                <span>Scope</span>
                <select value={memoryDraft.scope} onChange={(e) => setMemoryDraft((d) => d && { ...d, scope: e.target.value as Scope })}>
                  <option value="project">This project</option>
                  <option value="global">Global (every project)</option>
                </select>
              </label>
            </div>
            <label className="settings-field">
              <span>Content</span>
              <textarea className="instructions-textarea" value={memoryDraft.content} onChange={(e) => setMemoryDraft((d) => d && { ...d, content: e.target.value })} />
            </label>
            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={() => setMemoryDraft(null)}>
                Cancel
              </button>
              <button className="btn btn-allow" onClick={saveMemory}>
                Save memory
              </button>
            </div>
          </div>
        )}

        <div className="side-panel-title">
          Skills ({skills.length})
          <button className="settings-toggle memory-add-btn" onClick={() => setSkillDraft({ name: "", description: "", content: "", scope: "project" })}>
            + New
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
                  Edit
                </button>
                <button className="btn btn-deny" onClick={() => deleteSkillEntry(s)}>
                  Delete
                </button>
              </div>
            </div>
          ))}
          {skills.length === 0 && <div className="sidebar-empty">No skills yet.</div>}
        </div>

        {skillDraft && (
          <div className="provider-card">
            <label className="settings-field">
              <span>Name (slug)</span>
              <input type="text" value={skillDraft.name} onChange={(e) => setSkillDraft((d) => d && { ...d, name: e.target.value })} />
            </label>
            <label className="settings-field">
              <span>Description</span>
              <input type="text" value={skillDraft.description} onChange={(e) => setSkillDraft((d) => d && { ...d, description: e.target.value })} />
            </label>
            <label className="settings-field">
              <span>Scope</span>
              <select value={skillDraft.scope} onChange={(e) => setSkillDraft((d) => d && { ...d, scope: e.target.value as Scope })}>
                <option value="project">This project</option>
                <option value="global">Global (every project)</option>
              </select>
            </label>
            <label className="settings-field">
              <span>Content (Markdown instructions)</span>
              <textarea className="instructions-textarea" value={skillDraft.content} onChange={(e) => setSkillDraft((d) => d && { ...d, content: e.target.value })} />
            </label>
            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={() => setSkillDraft(null)}>
                Cancel
              </button>
              <button className="btn btn-allow" onClick={saveSkill}>
                Save skill
              </button>
            </div>
          </div>
        )}

        <div className="modal-actions">
          <button className="btn btn-allow" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
