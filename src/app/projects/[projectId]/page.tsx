import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";

import { GenerationPanel } from "@/components/projects/generation-panel";
import { ProjectWorkbenchFallback } from "@/components/projects/project-workbench-fallback";
import type { OwnedProjectPageSeed } from "@/lib/projects/page-data";
import { getCurrentUser } from "@/lib/auth/session";
import { getProjectGenerationSnapshot } from "@/lib/generation/repository";
import { ACTIVE_GENERATION_STATUSES } from "@/lib/generation/types";
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
  const generationIsActive = seed.job
    ? ACTIVE_GENERATION_STATUSES.some((status) => status === seed.job?.status)
    : false;

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
        <p aria-live="polite" className="project-status">
          {generationIsActive
            ? "Your request is saved. The Agent is generating the next preview."
            : "The Agent works beside the live preview. Stop it anytime."}
        </p>
      </header>
      <Suspense fallback={<ProjectWorkbenchFallback />}>
        <ProjectWorkbench seed={seed} />
      </Suspense>
    </main>
  );
}
