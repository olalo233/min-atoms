import Link from "next/link";

import { ProjectWorkbenchFallback } from "@/components/projects/project-workbench-fallback";

export default function LoadingProject() {
  return (
    <main
      aria-busy="true"
      className="shell builder-shell"
      id="main-content"
    >
      <header className="product-header project-header">
        <div className="project-identity">
          <Link className="back-link" href="/workspace">
            ← Workspace
          </Link>
          <span className="project-header-divider" aria-hidden="true" />
          <div>
            <p className="eyebrow">Project</p>
            <h1>Opening project…</h1>
          </div>
        </div>
        <p className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">
            m/a
          </span>
          <span>min-atoms</span>
        </p>
        <p className="project-status">Loading the latest project state.</p>
      </header>
      <ProjectWorkbenchFallback />
    </main>
  );
}
