"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { ProjectSummary } from "@min-atoms/protocol";
import { Loader2 } from "lucide-react";

import { Composer } from "@/components/home/composer";
import { EXAMPLE_PROMPTS } from "@/components/home/example-prompts";
import {
  MOCK_CREATED_PROJECT_ID,
  MOCK_PROJECTS,
  USE_MOCK_HOME,
} from "@/components/home/mock-projects";
import { ProjectCard } from "@/components/home/project-card";
import { AppHeader } from "@/components/shell/app-header";
import { Skeleton } from "@/components/ui/skeleton";

function byUpdatedAtDesc(a: ProjectSummary, b: ProjectSummary) {
  return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
}

export function HomeScreen({ username }: { username: string }) {
  const router = useRouter();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [prompt, setPrompt] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
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
      // 失败时保留输入内容，在输入框下方提示。
      setSubmitError("创建项目失败，请重试");
      setIsSubmitting(false);
    }
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

  return (
    <div className="min-h-dvh bg-zinc-50">
      <AppHeader username={username} />
      <main
        className="mx-auto w-full max-w-3xl px-6 pb-24 pt-14"
        id="main-content"
      >
        <h1 className="text-center text-2xl font-semibold tracking-tight text-zinc-900">
          你想做个什么应用？
        </h1>
        <p className="mt-2 text-center text-sm text-zinc-500">
          描述你的想法，AI 会在真实环境里把它搭出来，你可以直接使用
        </p>
        <div className="mt-8">
          <Composer
            error={submitError}
            isSubmitting={isSubmitting}
            onChange={setPrompt}
            onSubmit={(value) => void handleSubmit(value)}
            textareaRef={textareaRef}
            value={prompt}
          />
          <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
            {EXAMPLE_PROMPTS.map((example) => (
              <button
                className="rounded-full border border-zinc-200 bg-white px-4 py-1.5 text-sm text-zinc-700 shadow-sm transition hover:border-indigo-300 hover:text-indigo-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600"
                key={example.label}
                onClick={() => fillExample(example.prompt)}
                type="button"
              >
                <span aria-hidden="true" className="mr-1.5">
                  {example.icon}
                </span>
                {example.label}
              </button>
            ))}
          </div>
        </div>
        <section aria-labelledby="projects-heading" className="mt-14">
          <h2
            className="text-sm font-semibold text-zinc-900"
            id="projects-heading"
          >
            我的项目
          </h2>
          <div className="mt-4">
            {projects === null && !loadError ? (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {[0, 1, 2].map((index) => (
                  <Skeleton
                    className="h-44 rounded-2xl"
                    key={index}
                  />
                ))}
              </div>
            ) : loadError ? (
              <div className="rounded-2xl border border-zinc-200 bg-white px-6 py-10 text-center">
                <p className="text-sm text-red-600" role="alert">
                  项目列表加载失败
                </p>
                <button
                  aria-busy={isRetrying}
                  className="mt-3 inline-flex items-center gap-1.5 rounded-xl border border-zinc-200 bg-white px-4 py-1.5 text-sm text-zinc-700 transition hover:border-zinc-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:border-zinc-200"
                  disabled={isRetrying}
                  onClick={() => void handleRetry()}
                  type="button"
                >
                  {isRetrying ? (
                    <>
                      <Loader2
                        aria-hidden="true"
                        className="size-4 animate-spin"
                      />
                      重试中…
                    </>
                  ) : (
                    "重试"
                  )}
                </button>
              </div>
            ) : projects !== null && projects.length === 0 ? (
              <p className="rounded-2xl border border-dashed border-zinc-300 bg-white px-6 py-10 text-center text-sm text-zinc-500">
                还没有项目，从上面的示例开始吧
              </p>
            ) : (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {projects?.map((project) => (
                  <ProjectCard
                    key={project.id}
                    onDeleted={handleDeleted}
                    project={project}
                  />
                ))}
              </div>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
