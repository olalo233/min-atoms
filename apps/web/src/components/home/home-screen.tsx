"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { ProjectSummary } from "@min-atoms/protocol";
import { Boxes, CircleAlert, Loader2, RotateCw } from "lucide-react";

import { Composer } from "@/components/home/composer";
import { EXAMPLE_PROMPTS } from "@/components/home/example-prompts";
import {
  MOCK_CREATED_PROJECT_ID,
  MOCK_PROJECTS,
  USE_MOCK_HOME,
} from "@/components/home/mock-projects";
import { ProcessRail } from "@/components/home/process-rail";
import { ProjectCard } from "@/components/home/project-card";
import { AppHeader } from "@/components/shell/app-header";
import { WorkbenchSkeleton } from "@/components/workbench/workbench-skeleton";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

// ux §5：输入框聚焦时预取工作台路由代码。id 任意，只为匹配 /p/[id] 路由，
// 不创建项目，也不触达任何数据接口。
const PREFETCH_ROUTE_ID = "00000000-0000-4000-8000-0000000000d1";

function byUpdatedAtDesc(a: ProjectSummary, b: ProjectSummary) {
  return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
}

export function HomeScreen({ username }: { username: string }) {
  const router = useRouter();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [prompt, setPrompt] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // ux §5/§7.1：提交后立即在本页渲染工作台骨架过渡态，POST 成功后再切路由。
  const [showWorkbenchTransition, setShowWorkbenchTransition] = useState(false);
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);

  const loadProjects = useCallback(async () => {
    if (USE_MOCK_HOME) {
      // 模拟加载延迟，避免在 effect 里同步 setState，也让骨架屏可见。
      await new Promise((resolve) => setTimeout(resolve, 300));
      setProjects([...MOCK_PROJECTS].sort(byUpdatedAtDesc));
      setLoadError(false);
      return;
    }
    try {
      const response = await fetch("/api/projects", { cache: "no-store" });
      if (!response.ok) throw new Error(`load failed: ${response.status}`);
      const data = (await response.json()) as ProjectSummary[];
      setProjects([...data].sort(byUpdatedAtDesc));
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, []);

  useEffect(() => {
    // 延迟一个 tick 触发首次加载，setState 只发生在回调里。
    const timer = setTimeout(() => void loadProjects(), 0);
    return () => clearTimeout(timer);
  }, [loadProjects]);

  async function handleRetry() {
    // ux §3：按钮点击后立即进入加载态（禁用加 spinner），不重复触发。
    if (isRetrying) return;
    setIsRetrying(true);
    try {
      await loadProjects();
    } finally {
      setIsRetrying(false);
    }
  }

  async function handleSubmit(value: string) {
    if (isSubmitting) return;
    setSubmitError(null);
    setIsSubmitting(true);
    setShowWorkbenchTransition(true);
    try {
      if (USE_MOCK_HOME) {
        // 开发预览：模拟创建后跳转；/p/[id] 由 T16 提供。
        await new Promise((resolve) => setTimeout(resolve, 300));
        router.push(`/p/${MOCK_CREATED_PROJECT_ID}`);
        return;
      }
      const response = await fetch("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: value }),
      });
      if (!response.ok) throw new Error(`create failed: ${response.status}`);
      const body = (await response.json()) as { id: string };
      router.push(`/p/${body.id}`);
    } catch {
      // 失败时回到首页表单：保留输入内容，在输入框下方提示。
      setShowWorkbenchTransition(false);
      setSubmitError("创建项目失败，请重试");
      setIsSubmitting(false);
    }
  }

  function handleComposerFocus() {
    router.prefetch(`/p/${PREFETCH_ROUTE_ID}`);
  }

  function handleDeleted(projectId: string) {
    setProjects((current) =>
      current ? current.filter((project) => project.id !== projectId) : current,
    );
  }

  function fillExample(examplePrompt: string) {
    setPrompt(examplePrompt);
    textareaRef.current?.focus();
  }

  if (showWorkbenchTransition) {
    return <WorkbenchSkeleton />;
  }

  return (
    <div className="min-h-dvh bg-zinc-50">
      <AppHeader username={username} />
      <main className="relative isolate pb-24" id="main-content">
        <div aria-hidden="true" className="bench-mat-hero -z-10 h-[34rem]" />
        <section aria-labelledby="home-heading" className="mx-auto w-full max-w-2xl px-4 pt-12 sm:px-6 sm:pt-20 lg:pt-24">
          <ProcessRail />
          <h1
            className="mt-6 text-center text-[28px] leading-[1.2] font-semibold tracking-[-0.03em] text-balance text-zinc-900 sm:text-4xl sm:leading-[1.15]"
            id="home-heading"
          >
            你想做个什么应用？
          </h1>
          <p className="mx-auto mt-3 max-w-md text-center text-[15px] leading-relaxed text-pretty text-zinc-500">
            描述你的想法，AI 会在真实环境里把它搭出来，你可以直接使用
          </p>
          <div className="mt-8 sm:mt-10">
            <Composer
              error={submitError}
              isSubmitting={isSubmitting}
              onChange={setPrompt}
              onFocus={handleComposerFocus}
              onSubmit={(value) => void handleSubmit(value)}
              textareaRef={textareaRef}
              value={prompt}
            />
            <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
              <span className="w-full text-center text-xs text-zinc-400 sm:w-auto sm:pr-1">试试这些</span>
              {EXAMPLE_PROMPTS.map((example) => (
                <button
                  className="press inline-flex items-center gap-1.5 rounded-full bg-white px-3.5 py-1.5 text-[13px] text-zinc-700 shadow-[var(--shadow-card)] hover:text-indigo-700 hover:shadow-[0_0_0_1px_rgb(99_102_241/0.35),0_2px_8px_-2px_rgb(67_56_202/0.18)]"
                  key={example.label}
                  onClick={() => fillExample(example.prompt)}
                  type="button"
                >
                  <span aria-hidden="true">{example.icon}</span>
                  {example.label}
                </button>
              ))}
            </div>
          </div>
        </section>
        <section aria-labelledby="projects-heading" className="mx-auto mt-14 w-full max-w-5xl px-4 sm:mt-20 sm:px-6">
          <div className="flex items-baseline gap-2">
            <h2 className="text-[15px] font-semibold tracking-tight text-zinc-900" id="projects-heading">
              我的项目
            </h2>
            {projects && projects.length > 0 ? (
              <span className="font-mono text-xs text-zinc-400 tabular-nums">{projects.length}</span>
            ) : null}
          </div>
          <div className="mt-4">
            {projects === null && !loadError ? (
              <div aria-busy="true" aria-label="正在加载项目" className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {[0, 1, 2].map((index) => (
                  <div className="overflow-hidden rounded-2xl bg-white shadow-[var(--shadow-card)]" key={index}>
                    <Skeleton className="aspect-[16/10] rounded-none" />
                    <div className="space-y-2 px-4 py-3.5">
                      <Skeleton className="h-4 w-2/5 rounded-md" />
                      <Skeleton className="h-3 w-1/4 rounded-md" />
                    </div>
                  </div>
                ))}
              </div>
            ) : loadError ? (
              <div className="flex flex-col items-center rounded-2xl bg-white px-6 py-10 text-center shadow-[var(--shadow-card)]">
                <p className="flex items-center gap-1.5 text-sm text-red-600" role="alert">
                  <CircleAlert aria-hidden="true" className="size-4" />
                  项目列表加载失败
                </p>
                <Button
                  aria-busy={isRetrying}
                  className="mt-4"
                  disabled={isRetrying}
                  onClick={() => void handleRetry()}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  {isRetrying ? (
                    <>
                      <Loader2 aria-hidden="true" className="size-4 animate-spin" />
                      重试中…
                    </>
                  ) : (
                    <>
                      <RotateCw aria-hidden="true" className="size-3.5" />
                      重试
                    </>
                  )}
                </Button>
              </div>
            ) : projects !== null && projects.length === 0 ? (
              <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-zinc-300 px-6 py-12 text-center">
                <span className="flex size-10 items-center justify-center rounded-xl bg-white text-zinc-400 shadow-[var(--shadow-card)]">
                  <Boxes aria-hidden="true" className="size-5" />
                </span>
                <p className="text-sm text-zinc-500">还没有项目，从上面的示例开始吧</p>
              </div>
            ) : (
              <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {projects?.map((project) => (
                  <li className="min-w-0" key={project.id}>
                    <ProjectCard onDeleted={handleDeleted} project={project} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
