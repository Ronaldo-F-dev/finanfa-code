import { useState } from "react";
import type { MemoryEntry, MemoryScope, MemoryStatus, SkillEntry } from "../hooks/useAgentBridge";

const MEMORY_TYPES = ["user", "feedback", "project", "reference"];

interface Draft {
  name: string;
  description: string;
  content: string;
  scope: MemoryScope;
}

type MemoryDraft = Draft & { type: string };

interface MemoryPanelProps {
  status: MemoryStatus;
  loaded: boolean;
  onClose: () => void;
  onSaveMemory: (entry: MemoryEntry) => void;
  onDeleteMemory: (name: string, scope: MemoryScope) => void;
  onSaveSkill: (entry: SkillEntry) => void;
  onDeleteSkill: (name: string, scope: MemoryScope) => void;
}

/**
 * The webview's own Memory & skills panel — the same panel web-client and
 * the Flutter app already have, and the last piece useAgentBridge.ts's
 * header comment listed as dropped. Ported from web-client's
 * MemoryPanel.tsx with its French wording hardcoded, like the rest of this
 * webview, and without Icon (no icon set here).
 *
 * Every write goes through the extension to the same core functions the
 * agent's own write_memory tool uses, so a note edited here and one written
 * mid-conversation are the same file, in the same format, under the same
 * project/global scopes.
 */
export function MemoryPanel({ status, loaded, onClose, onSaveMemory, onDeleteMemory, onSaveSkill, onDeleteSkill }: MemoryPanelProps) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [memoryDraft, setMemoryDraft] = useState<MemoryDraft | null>(null);
  const [skillDraft, setSkillDraft] = useState<Draft | null>(null);

  function toggle(key: string): void {
    setOpenKey((current) => (current === key ? null : key));
  }

  function startMemory(entry?: MemoryEntry): void {
    setMemoryDraft(
      entry
        ? { name: entry.name, description: entry.description, content: entry.content, scope: entry.scope, type: entry.type }
        : { name: "", description: "", content: "", scope: "project", type: "user" },
    );
  }

  function startSkill(entry?: SkillEntry): void {
    setSkillDraft(entry ? { name: entry.name, description: entry.description, content: entry.content, scope: entry.scope } : { name: "", description: "", content: "", scope: "project" });
  }

  function submitMemory(): void {
    if (!memoryDraft || !memoryDraft.name.trim() || !memoryDraft.content.trim()) return;
    onSaveMemory(memoryDraft);
    setMemoryDraft(null);
  }

  function submitSkill(): void {
    if (!skillDraft || !skillDraft.name.trim() || !skillDraft.content.trim()) return;
    onSaveSkill(skillDraft);
    setSkillDraft(null);
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal panel-modal memory-modal" onClick={(event) => event.stopPropagation()}>
        <div className="panel-header">
          <span className="panel-header-title">Mémoire & compétences</span>
          <button className="panel-header-close" onClick={onClose} aria-label="Fermer">
            ×
          </button>
        </div>
        <p className="settings-hint">
          Les entrées globales s'appliquent à tous les projets de cette machine ; les entrées de projet ne s'appliquent qu'ici. L'agent les lit au
          démarrage d'une session : une nouvelle entrée est visible à la session suivante. Il peut aussi écrire une note lui-même avec l'outil de
          mémoire.
        </p>

        <div className="side-panel-title">
          Mémoire ({status.memories.length})
          <button className="settings-toggle memory-add-btn" onClick={() => startMemory()}>
            + Nouveau
          </button>
        </div>
        <div className="mcp-list">
          {status.memories.map((entry) => (
            <div className="mcp-row memory-row" key={entry.name}>
              <div className="mcp-row-main" onClick={() => toggle(`m:${entry.name}`)}>
                <div>
                  <div className="mcp-name">
                    {entry.name}
                    <span className="memory-type">{entry.type}</span>
                    <ScopePill scope={entry.scope} />
                  </div>
                  <div className="mcp-meta">{entry.description}</div>
                  {openKey === `m:${entry.name}` && <pre className="memory-content">{entry.content}</pre>}
                </div>
              </div>
              <div className="mcp-row-actions">
                <button className="btn btn-ghost" onClick={() => startMemory(entry)}>
                  Modifier
                </button>
                <button className="btn btn-deny" onClick={() => onDeleteMemory(entry.name, entry.scope)}>
                  Supprimer
                </button>
              </div>
            </div>
          ))}
          {loaded && status.memories.length === 0 && <div className="sidebar-empty">Rien d'enregistré pour l'instant.</div>}
          {!loaded && <div className="sidebar-empty">Chargement de la mémoire…</div>}
        </div>

        {memoryDraft && (
          <MemoryEditor draft={memoryDraft} onChange={setMemoryDraft} onCancel={() => setMemoryDraft(null)} onSave={submitMemory} />
        )}

        <div className="side-panel-title">
          Compétences ({status.skills.length})
          <button className="settings-toggle memory-add-btn" onClick={() => startSkill()}>
            + Nouveau
          </button>
        </div>
        <div className="mcp-list">
          {status.skills.map((entry) => (
            <div className="mcp-row memory-row" key={entry.name}>
              <div className="mcp-row-main" onClick={() => toggle(`s:${entry.name}`)}>
                <div>
                  <div className="mcp-name">
                    {entry.name}
                    <ScopePill scope={entry.scope} />
                  </div>
                  <div className="mcp-meta">{entry.description}</div>
                  {openKey === `s:${entry.name}` && <pre className="memory-content">{entry.content}</pre>}
                </div>
              </div>
              <div className="mcp-row-actions">
                <button className="btn btn-ghost" onClick={() => startSkill(entry)}>
                  Modifier
                </button>
                <button className="btn btn-deny" onClick={() => onDeleteSkill(entry.name, entry.scope)}>
                  Supprimer
                </button>
              </div>
            </div>
          ))}
          {loaded && status.skills.length === 0 && <div className="sidebar-empty">Aucune compétence pour l'instant.</div>}
          {!loaded && <div className="sidebar-empty">Chargement des compétences…</div>}
        </div>

        {skillDraft && <SkillEditor draft={skillDraft} onChange={setSkillDraft} onCancel={() => setSkillDraft(null)} onSave={submitSkill} />}
      </div>
    </div>
  );
}

function ScopePill({ scope }: { scope: MemoryScope }) {
  return <span className="memory-scope">{scope === "global" ? "global" : "projet"}</span>;
}

function MemoryEditor({
  draft,
  onChange,
  onCancel,
  onSave,
}: {
  draft: MemoryDraft;
  onChange: (draft: MemoryDraft) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  return (
    <div className="provider-card">
      <div className="provider-card-title">Mémoire</div>
      <TextField label="Nom (identifiant)" value={draft.name} onChange={(name) => onChange({ ...draft, name })} />
      <TextField label="Description" value={draft.description} onChange={(description) => onChange({ ...draft, description })} />
      <div className="draft-row">
        <label className="settings-field">
          <span>Type</span>
          <select value={draft.type} onChange={(event) => onChange({ ...draft, type: event.target.value })}>
            {MEMORY_TYPES.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        </label>
        <ScopeField scope={draft.scope} onChange={(scope) => onChange({ ...draft, scope })} />
      </div>
      <label className="settings-field">
        <span>Contenu</span>
        <textarea className="instructions-textarea" value={draft.content} onChange={(event) => onChange({ ...draft, content: event.target.value })} />
      </label>
      <div className="modal-actions">
        <button className="btn btn-ghost" onClick={onCancel}>
          Annuler
        </button>
        <button className="btn btn-allow" onClick={onSave}>
          Enregistrer la mémoire
        </button>
      </div>
    </div>
  );
}

function SkillEditor({
  draft,
  onChange,
  onCancel,
  onSave,
}: {
  draft: Draft;
  onChange: (draft: Draft) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  return (
    <div className="provider-card">
      <div className="provider-card-title">Compétence</div>
      <TextField label="Nom (identifiant)" value={draft.name} onChange={(name) => onChange({ ...draft, name })} />
      <TextField label="Description" value={draft.description} onChange={(description) => onChange({ ...draft, description })} />
      <ScopeField scope={draft.scope} onChange={(scope) => onChange({ ...draft, scope })} />
      <label className="settings-field">
        <span>Contenu (instructions Markdown)</span>
        <textarea className="instructions-textarea" value={draft.content} onChange={(event) => onChange({ ...draft, content: event.target.value })} />
      </label>
      <div className="modal-actions">
        <button className="btn btn-ghost" onClick={onCancel}>
          Annuler
        </button>
        <button className="btn btn-allow" onClick={onSave}>
          Enregistrer la compétence
        </button>
      </div>
    </div>
  );
}

function TextField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="settings-field">
      <span>{label}</span>
      <input type="text" value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function ScopeField({ scope, onChange }: { scope: MemoryScope; onChange: (scope: MemoryScope) => void }) {
  return (
    <label className="settings-field">
      <span>Portée</span>
      <select value={scope} onChange={(event) => onChange(event.target.value === "global" ? "global" : "project")}>
        <option value="project">Ce projet</option>
        <option value="global">Global (tous les projets)</option>
      </select>
    </label>
  );
}
