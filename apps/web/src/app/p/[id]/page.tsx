import { Suspense } from "react";
import { redirect } from "next/navigation";

import { WorkbenchScreen, WorkbenchSkeleton } from "@/components/workbench/workbench-screen";
import { getCurrentUser } from "@/lib/auth/session";

import "../workbench.css";

// Mock mode (development only + NEXT_PUBLIC_MOCK_STREAM=1) renders fully
// local fake data and never touches the database, so the auth check is
// skipped there. Production builds always enforce authentication.
const MOCK_ENABLED = process.env.NODE_ENV === "development" && process.env.NEXT_PUBLIC_MOCK_STREAM === "1";

export default async function ProjectWorkbenchPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!MOCK_ENABLED) {
    const user = await getCurrentUser();
    if (!user) redirect("/login");
  }
  return (
    <Suspense fallback={<WorkbenchSkeleton />}>
      <WorkbenchScreen projectId={id} />
    </Suspense>
  );
}
