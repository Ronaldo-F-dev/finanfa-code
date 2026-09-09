import { useEffect, useState } from "react";
import { useLanguage } from "../i18n/LanguageContext";

export interface ProjectItem {
  id: string;
  name: string;
  createdAt: string;
  fileCount: number;
}

export function ProjectsListView({ onOpenProject }: { onOpenProject: (id: string) => void }) {
  const { t } = useLanguage();
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [newName, setNewName] = useState("");

  function refresh() {
    fetch("/api/projects")
      .then((r) => r.json())
      // "default" is the folder the server was started against (a dev/ops
      // detail — for this session, literally finanfa-code's own repo) —
      // not something a user ever created as a project, so it doesn't
      // belong in a list that's supposed to be "your projects".
      .then((data: { projects: ProjectItem[] }) => setProjects(data.projects.filter((p) => p.id !== "default")));
  }

  useEffect(refresh, []);

  async function handleCreate() {
    if (!newName.trim()) return;
    const res = await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName.trim() }),
    });
    const data = await res.json();
    setNewName("");
    onOpenProject(data.project.id);
  }

  return (
    <div className="page">
      <div className="page-header">
        <h1>{t("projects.title")}</h1>
        <p className="page-sub">{t("projects.sub")}</p>
      </div>

      <div className="projects-new page-new">
        <input
          type="text"
          placeholder={t("projects.newNamePlaceholder")}
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleCreate()}
        />
        <button className="btn btn-allow" onClick={handleCreate}>
          {t("projects.create")}
        </button>
      </div>

      <div className="project-grid">
        {projects.map((p) => (
          <div key={p.id} className="project-card" onClick={() => onOpenProject(p.id)}>
            <div className="project-card-icon">📁</div>
            <div className="project-card-name">{p.name}</div>
            <div className="mcp-meta">{t(p.fileCount === 1 ? "projects.fileCount" : "projects.fileCountPlural", { count: p.fileCount })}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
