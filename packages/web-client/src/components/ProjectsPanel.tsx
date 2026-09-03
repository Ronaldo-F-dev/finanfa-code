import { useEffect, useRef, useState } from "react";

interface ProjectItem {
  id: string;
  name: string;
  createdAt: string;
  fileCount: number;
}

interface KnowledgeFile {
  name: string;
  size: number;
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function ProjectsPanel({
  activeProjectId,
  onClose,
  onSelect,
}: {
  activeProjectId: string | undefined;
  onClose: () => void;
  onSelect: (id: string | undefined) => void;
}) {
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [newName, setNewName] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [files, setFiles] = useState<KnowledgeFile[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function refresh() {
    fetch("/api/projects")
      .then((r) => r.json())
      .then((data: { projects: ProjectItem[] }) => setProjects(data.projects));
  }

  useEffect(refresh, []);

  useEffect(() => {
    if (!expanded) return;
    fetch(`/api/projects/${expanded}/files`)
      .then((r) => r.json())
      .then((data: { files: KnowledgeFile[] }) => setFiles(data.files))
      .catch(() => setFiles([]));
  }, [expanded]);

  async function handleCreate() {
    if (!newName.trim()) return;
    const res = await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName.trim() }),
    });
    const data = await res.json();
    setNewName("");
    refresh();
    onSelect(data.project.id);
    onClose();
  }

  async function handleDelete(id: string) {
    await fetch(`/api/projects/${id}`, { method: "DELETE" });
    if (id === activeProjectId) onSelect(undefined);
    refresh();
  }

  async function handleUploadKnowledge(projectId: string, fileList: FileList | null) {
    if (!fileList) return;
    for (const file of Array.from(fileList)) {
      const dataBase64 = await readFileAsBase64(file);
      await fetch(`/api/projects/${projectId}/files`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: file.name, dataBase64 }),
      });
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
    fetch(`/api/projects/${projectId}/files`)
      .then((r) => r.json())
      .then((data: { files: KnowledgeFile[] }) => setFiles(data.files));
    refresh();
  }

  async function handleDeleteFile(projectId: string, name: string) {
    await fetch(`/api/projects/${projectId}/files/${encodeURIComponent(name)}`, { method: "DELETE" });
    setFiles((f) => f.filter((file) => file.name !== name));
    refresh();
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal projects-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">Projects</div>
        <p className="settings-hint">
          Each project is an isolated workspace with its own files, chats, and reference material — the agent only ever sees the project it's
          currently working in.
        </p>

        <div className="projects-new">
          <input
            type="text"
            placeholder="New project name…"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleCreate()}
          />
          <button className="btn btn-allow" onClick={handleCreate}>
            + Create
          </button>
        </div>

        <div className="projects-list">
          {projects.map((p) => (
            <div key={p.id} className="project-row">
              <div className="project-row-main" onClick={() => onSelect(p.id === "default" ? undefined : p.id)}>
                <span className={`conn-dot ${p.id === (activeProjectId ?? "default") ? "conn-on" : "conn-off"}`} />
                <div>
                  <div className="project-name">{p.name}</div>
                  <div className="mcp-meta">{p.fileCount} file(s)</div>
                </div>
              </div>
              <div className="project-row-actions">
                <a className="btn btn-ghost" href={`/api/projects/${p.id}/download`} download>
                  Download
                </a>
                <button className="btn btn-ghost" onClick={() => setExpanded((e) => (e === p.id ? null : p.id))}>
                  {expanded === p.id ? "Hide files" : "Knowledge"}
                </button>
                {p.id !== "default" && (
                  <button className="btn btn-deny" onClick={() => handleDelete(p.id)}>
                    Delete
                  </button>
                )}
              </div>
              {expanded === p.id && (
                <div className="project-knowledge">
                  <input ref={fileInputRef} type="file" multiple hidden onChange={(e) => handleUploadKnowledge(p.id, e.target.files)} />
                  <button className="btn btn-ghost" onClick={() => fileInputRef.current?.click()}>
                    + Add knowledge files
                  </button>
                  {files.length === 0 && <div className="sidebar-empty">No reference files yet.</div>}
                  {files.map((f) => (
                    <div className="project-file-row" key={f.name}>
                      <span>{f.name}</span>
                      <button onClick={() => handleDeleteFile(p.id, f.name)}>×</button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
