import { useEffect, useState } from "react";

interface Skill {
  name: string;
  description: string;
  content: string;
}

interface Memory {
  name: string;
  description: string;
  type: string;
  content: string;
}

export function MemoryPanel({ projectId, onClose }: { projectId: string | undefined; onClose: () => void }) {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    const qs = projectId ? `?project=${encodeURIComponent(projectId)}` : "";
    fetch(`/api/skills${qs}`)
      .then((r) => r.json())
      .then((data: { skills: Skill[] }) => setSkills(data.skills));
    fetch(`/api/memory${qs}`)
      .then((r) => r.json())
      .then((data: { memories: Memory[] }) => setMemories(data.memories));
  }, [projectId]);

  function toggle(key: string) {
    setExpanded((e) => (e === key ? null : key));
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal mcp-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">Memory & skills</div>
        <p className="settings-hint">
          Memory is written by the agent itself (write_memory) when you correct it or share lasting context — global entries apply everywhere, project
          ones only here. Skills are hand-authored Markdown files under <code>.finanfa-code/skills/</code>.
        </p>

        <div className="side-panel-title">Memory ({memories.length})</div>
        <div className="mcp-list">
          {memories.map((m) => (
            <div className="mcp-row memory-row" key={m.name} onClick={() => toggle(`m-${m.name}`)}>
              <div className="mcp-row-main">
                <div>
                  <div className="mcp-name">
                    {m.name} <span className="memory-type">{m.type}</span>
                  </div>
                  <div className="mcp-meta">{m.description}</div>
                  {expanded === `m-${m.name}` && <pre className="memory-content">{m.content}</pre>}
                </div>
              </div>
            </div>
          ))}
          {memories.length === 0 && <div className="sidebar-empty">Nothing saved yet — the agent writes here as it learns things worth remembering.</div>}
        </div>

        <div className="side-panel-title">Skills ({skills.length})</div>
        <div className="mcp-list">
          {skills.map((s) => (
            <div className="mcp-row memory-row" key={s.name} onClick={() => toggle(`s-${s.name}`)}>
              <div className="mcp-row-main">
                <div>
                  <div className="mcp-name">{s.name}</div>
                  <div className="mcp-meta">{s.description}</div>
                  {expanded === `s-${s.name}` && <pre className="memory-content">{s.content}</pre>}
                </div>
              </div>
            </div>
          ))}
          {skills.length === 0 && <div className="sidebar-empty">No skills defined for this project.</div>}
        </div>

        <div className="modal-actions">
          <button className="btn btn-allow" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
