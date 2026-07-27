import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";

import { GenerationPanel } from "@/components/projects/generation-panel";
import type { OwnedProjectPageSeed } from "@/lib/projects/page-data";
import { getCurrentUser } from "@/lib/auth/session";
import { getProjectGenerationSnapshot } from "@/lib/generation/repository";
import { getProjectMessages } from "@/lib/projects/messages";
import { getOwnedProjectPageSeed } from "@/lib/projects/page-data";

type ProjectPageProps = {
  params: Promise<{ projectId: string }>;
};

async function ProjectWorkbench({
  seed,
}: {
  seed: OwnedProjectPageSeed;
}) {
  const [generation, messages] = await Promise.all([
    getProjectGenerationSnapshot(seed.job, seed.artifactVersion),
    getProjectMessages(seed.project.id),
  ]);

  return (
    <GenerationPanel
      buildRequest={seed.buildRequest.content}
      initialGeneration={generation}
      initialMessages={messages}
      projectId={seed.project.id}
    />
  );
}

function ProjectWorkbenchFallback() {
  return (
    <section
      aria-busy="true"
      aria-labelledby="generation-title"
      className="generation-section"
    >
      <h2 className="visually-hidden" id="generation-title">
        Builder workbench
      </h2>
      <div className="builder-grid">
        <aside
          aria-label="Loading project conversation"
          className="evidence-column"
        >
          <section
            aria-labelledby="conversation-title"
            className="conversation-panel"
          >
            <div className="conversation-heading">
              <div>
                <p className="request-label">Project conversation</p>
                <h3 id="conversation-title">You and the Agent</h3>
              </div>
            </div>
            <div className="conversation-list">
              <p className="request-content">Loading conversation…</p>
            </div>
          </section>
        </aside>
        <div className="preview-panel">
          <div className="preview-waiting">
            <div className="waiting-register">
              <span>Preview</span>
              <span>Loading project state</span>
            </div>
            <div className="waiting-aperture">
              <span className="waiting-mark" />
              <p>The project shell is ready. Loading the latest version…</p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

export default async function ProjectPage({ params }: ProjectPageProps) {
  const user = await getCurrentUser();
  if (!user) {
    redirect("/login");
  }

  const { projectId } = await params;
  const seed = await getOwnedProjectPageSeed(user.id, projectId);
  if (!seed) {
    notFound();
  }

  return (
    <main className="shell builder-shell" id="main-content">
      <header className="product-header project-header">
        <div className="project-identity">
          <Link className="back-link" href="/workspace">← Workspace</Link>
          <span className="project-header-divider" aria-hidden="true" />
          <div>
            <p className="eyebrow">Project</p>
            <h1 id="project-title">{seed.project.name}</h1>
          </div>
        </div>
        <p className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">m/a</span>
          <span>min-atoms</span>
        </p>
        <p className="project-status">
          The agent works beside the live preview. Stop it anytime.
        </p>
      </header>
      <Suspense fallback={<ProjectWorkbenchFallback />}>
        <ProjectWorkbench seed={seed} />
      </Suspense>
    </main>
  );
}
