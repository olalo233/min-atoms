import { redirect } from "next/navigation";

import { LogoutButton } from "@/components/auth/logout-button";
import { getCurrentUser } from "@/lib/auth/session";
import { CreateProjectForm } from "@/components/projects/create-project-form";
import { ProjectList } from "@/components/projects/project-list";
import { listOwnedProjects } from "@/lib/projects/repository";

export default async function WorkspacePage() {
  const user = await getCurrentUser();
  if (!user) {
    redirect("/login");
  }

  const projects = await listOwnedProjects(user.id);
  const projectSummaries = projects.map((project) => ({
    id: project.id,
    name: project.name,
    updatedLabel: project.updatedAt.toLocaleDateString(),
  }));

  return (
    <main className="shell workspace-shell" id="main-content">
      <header className="product-header">
        <p className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">m/a</span>
          <span>min-atoms</span>
        </p>
        <nav className="user-controls" aria-label="Account">
          <span className="user-label">Signed in as <strong>{user.username}</strong></span>
          <LogoutButton />
        </nav>
      </header>
      <section className="composer-section" aria-labelledby="workspace-title">
        <p className="eyebrow">New project</p>
        <h1 id="workspace-title">Describe the app you want</h1>
        <p className="lede">
          Write one request. The agent plans, builds, and validates a small
          interactive app you can inspect and refine.
        </p>
        <CreateProjectForm />
      </section>
      <section className="recent-projects" aria-labelledby="recent-projects-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Recent projects</p>
            <h2 id="recent-projects-title">Pick up where you left off</h2>
          </div>
          <span className="item-count" aria-label={`${projects.length} projects`}>
            {projects.length}
          </span>
        </div>
        <ProjectList projects={projectSummaries} />
      </section>
    </main>
  );
}
