import Link from "next/link";
import { redirect } from "next/navigation";

import { LogoutButton } from "@/components/auth/logout-button";
import { getCurrentUser } from "@/lib/auth/session";
import { CreateProjectForm } from "@/components/projects/create-project-form";
import { listOwnedProjects } from "@/lib/projects/repository";

export default async function WorkspacePage() {
  const user = await getCurrentUser();
  if (!user) {
    redirect("/login");
  }

  const projects = await listOwnedProjects(user.id);

  return (
    <main className="shell workspace-shell" id="main-content">
      <header className="product-header">
        <p className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">m/a</span>
          <span>min-atoms</span>
        </p>
        <div className="user-controls">
          <span className="user-label">Signed in as <strong>{user.username}</strong></span>
          <LogoutButton />
        </div>
      </header>
      <div className="workspace-layout">
        <section className="workspace-card" aria-labelledby="workspace-title">
          <p className="eyebrow">New project / Build Request</p>
          <h1 id="workspace-title">What should the workbench make?</h1>
          <p className="lede">
            Describe one small interactive application. You will see the Agent
            plan, generate, validate, and present it for inspection.
          </p>
          <CreateProjectForm />
        </section>
        <section className="recent-projects" aria-labelledby="recent-projects-title">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Project history</p>
              <h2 id="recent-projects-title">Return to a workpiece</h2>
            </div>
            <span className="item-count" aria-label={`${projects.length} projects`}>
              {projects.length.toString().padStart(2, "0")}
            </span>
          </div>
          {projects.length > 0 ? (
            <div className="project-list">
              {projects.map((project) => (
                <Link
                  className="project-card project-card-link"
                  href={`/projects/${project.id}`}
                  key={project.id}
                >
                  <span className="project-card-name">{project.name}</span>
                  <span className="project-card-meta">
                    Updated {project.updatedAt.toLocaleDateString()}
                  </span>
                  <span className="project-card-action" aria-hidden="true">Open →</span>
                </Link>
              ))}
            </div>
          ) : (
            <div className="empty-state">
              <strong>No projects yet</strong>
              <span>Your first completed request will remain available here.</span>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
