import { Atom } from "lucide-react";

// Placeholder page shown before the agent writes the real app.
// The agent replaces this file entirely when building the first feature.
export default function App() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-zinc-50 px-6 text-center">
      <div className="animate-breathe flex size-20 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 to-indigo-700 shadow-lg shadow-indigo-200">
        <Atom className="size-10 text-white" aria-hidden />
      </div>
      <h1 className="mt-8 text-2xl font-semibold tracking-tight text-zinc-900">
        应用正在搭建中…
      </h1>
      <p className="mt-3 max-w-md text-sm leading-relaxed text-zinc-500">
        AI 正在根据你的描述编写代码，这里会实时更新
      </p>
    </div>
  );
}
