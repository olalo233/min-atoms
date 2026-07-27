"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

export type ProjectSummary = {
  id: string;
  name: string;
  updatedLabel: string;
};

type ProjectListProps = {
  projects: ProjectSummary[];
};

export function ProjectList({ projects }: ProjectListProps) {
  const router = useRouter();
  const prefetchedRoutes = useRef(new Set<string>());
  const [items, setItems] = useState(projects);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  function prefetchProject(projectId: string) {
    const route = `/projects/${projectId}`;
    if (prefetchedRoutes.current.has(route)) return;
    prefetchedRoutes.current.add(route);
    router.prefetch(route);
  }

  async function deleteProject(projectId: string) {
    setErrors((current) => {
      const next = { ...current };
      delete next[projectId];
      return next;
    });
    setDeletingId(projectId);
    try {
      const response = await fetch(`/api/projects/${projectId}`, {
        method: "DELETE",
      });
      if (response.status === 204) {
        setItems((current) => current.filter((item) => item.id !== projectId));
        setConfirmId(null);
        return;
      }
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      setErrors((current) => ({
        ...current,
        [projectId]:
          body.error ??
          (response.status === 409
            ? "Stop the active agent before deleting this project."
            : "Project could not be deleted. Try again."),
      }));
    } catch {
      setErrors((current) => ({
        ...current,
        [projectId]: "Project could not be deleted. Try again.",
      }));
    } finally {
      setDeletingId(null);
    }
  }

  if (items.length === 0) {
    return (
      <div className="empty-state">
        <strong>No projects yet</strong>
        <span>Describe your first build above and it will appear here.</span>
      </div>
    );
  }

  return (
    <ul className="project-list">
      {items.map((project) => {
        const isConfirming = confirmId === project.id;
        const isDeleting = deletingId === project.id;
        const deleteError = errors[project.id];
        return (
          <li className="project-card" key={project.id}>
            <div className="project-card-main">
              <Link
                className="project-card-link"
                href={`/projects/${project.id}`}
                onFocus={() => prefetchProject(project.id)}
                onPointerEnter={() => prefetchProject(project.id)}
                prefetch
              >
                <span className="project-card-name">{project.name}</span>
                <span className="project-card-meta">
                  Updated {project.updatedLabel}
                </span>
                <span className="project-card-action" aria-hidden="true">
                  Open →
                </span>
              </Link>
              {isConfirming ? (
                <div
                  aria-label={`Confirm deletion of ${project.name}`}
                  className="delete-confirm"
                  role="group"
                >
                  <button
                    aria-busy={isDeleting}
                    className="danger-button"
                    disabled={isDeleting}
                    onClick={() => void deleteProject(project.id)}
                    type="button"
                  >
                    {isDeleting ? "Deleting…" : "Confirm delete"}
                  </button>
                  <button
                    className="quiet-button"
                    disabled={isDeleting}
                    onClick={() => setConfirmId(null)}
                    type="button"
                  >
                    Keep project
                  </button>
                </div>
              ) : (
                <button
                  className="quiet-button project-delete"
                  onClick={() => setConfirmId(project.id)}
                  type="button"
                >
                  Delete
                </button>
              )}
            </div>
            {deleteError ? (
              <p className="error project-card-error" role="alert">
                {deleteError}
              </p>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
