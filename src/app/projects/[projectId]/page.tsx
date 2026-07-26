import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { GenerationPanel } from "@/components/projects/generation-panel";
import { getCurrentUser } from "@/lib/auth/session";
import { getOwnedGenerationSnapshot } from "@/lib/generation/repository";
import { getOwnedProject } from "@/lib/projects/repository";

type ProjectPageProps = {
  params: Promise<{ projectId: string }>;
};

export default async function ProjectPage({ params }: ProjectPageProps) {
  const user = await getCurrentUser();
  if (!user) {
    redirect("/login");
  }

  const { projectId } = await params;
  const result = await getOwnedProject(user.id, projectId);
  if (!result) {
    notFound();
  }
  const generation = await getOwnedGenerationSnapshot(user.id, projectId);
  if (!generation) {
    notFound();
  }

  return (
    <main className="shell builder-shell" id="main-content">
      <header className="product-header project-header">
        <Link className="back-link" href="/workspace">← Workspace</Link>
        <p className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">m/a</span>
          <span>min-atoms</span>
        </p>
      </header>
      <section className="project-heading" aria-labelledby="project-title">
        <div>
          <p className="eyebrow">Project</p>
          <h1 id="project-title">{result.project.name}</h1>
        </div>
        <p className="project-status">
          The agent works beside the live preview. Stop it anytime.
        </p>
      </section>
      <GenerationPanel
        buildRequest={result.buildRequest.content}
        initialGeneration={generation}
        projectId={projectId}
      />
    </main>
  );
}
