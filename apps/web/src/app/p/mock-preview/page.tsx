import { notFound } from "next/navigation";
import { Search, Star } from "lucide-react";

import "../workbench.css";

const RECIPES = [
  { title: "番茄炒蛋", tag: "家常", minutes: 15, favorite: true },
  { title: "红烧肉", tag: "硬菜", minutes: 90, favorite: true },
  { title: "清蒸鲈鱼", tag: "海鲜", minutes: 25, favorite: false },
  { title: "蒜蓉西兰花", tag: "素菜", minutes: 10, favorite: false },
];

/**
 * Fake generated app shown in the preview iframe in mock mode
 * (development only + NEXT_PUBLIC_MOCK_STREAM=1). Fully static and local;
 * 404 otherwise so production builds never expose it.
 */
export default function MockPreviewPage() {
  if (process.env.NODE_ENV !== "development" || process.env.NEXT_PUBLIC_MOCK_STREAM !== "1") notFound();

  return (
    <main className="wb-root min-h-dvh bg-zinc-50 p-6 text-zinc-900">
      <div className="mx-auto max-w-xl space-y-5">
        <header className="space-y-1">
          <h1 className="text-xl font-semibold">食谱收藏夹</h1>
          <p className="text-sm text-zinc-500">搜索食谱，收藏喜欢的。</p>
        </header>
        <div className="flex items-center gap-2 rounded-2xl border border-zinc-200 bg-white px-3.5 py-2.5 shadow-sm">
          <Search className="size-4 text-zinc-400" />
          <span className="text-sm text-zinc-400">搜索食谱…</span>
        </div>
        <ul className="space-y-3">
          {RECIPES.map((recipe) => (
            <li
              key={recipe.title}
              className="flex items-center gap-3 rounded-2xl border border-zinc-200 bg-white px-4 py-3 shadow-sm"
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{recipe.title}</p>
                <p className="text-xs text-zinc-500">
                  {recipe.tag} · 约 {recipe.minutes} 分钟
                </p>
              </div>
              <Star className={recipe.favorite ? "size-4 fill-amber-400 text-amber-400" : "size-4 text-zinc-300"} />
            </li>
          ))}
        </ul>
      </div>
    </main>
  );
}
