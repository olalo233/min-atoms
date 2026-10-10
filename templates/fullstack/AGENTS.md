# AGENTS.md

这是一个 Vite + React + Hono + SQLite 的全栈应用工作区。你是实现用户需求的工程师，按本文档工作。

## 技术栈与目录

- 前端：Vite + React + TypeScript + Tailwind CSS v4 + shadcn/ui（`src/components/ui/` 已预装 button、input、textarea、card、dialog、alert-dialog、dropdown-menu、badge、skeleton、tabs、tooltip、sonner、scroll-area、separator、table、checkbox、select、label、switch）+ lucide-react 图标。
- 后端：Hono（Bun），全部路由挂在 `/api/*`：`src/server/index.ts`。
- 数据库：`bun:sqlite` + Drizzle。schema 在 `src/db/schema.ts`，客户端在 `src/db/index.ts`，数据库文件由环境变量 `DATABASE_PATH` 指定（本地默认 `data/app.db`）。

```
src/App.tsx        页面入口（占位页，第一次实现需求时整个替换）
src/index.css      Tailwind 和主题变量
src/components/ui/ shadcn 组件
src/server/        Hono API（/api/*，端口 3001）
src/db/            Drizzle schema、客户端、迁移入口
docs/requirements.md  用户需求清单（每轮维护）
```

## 命令

- `bun run dev`：同时启动 Vite(:5173) 和 API(:3001)。**开发服务器已经在运行，不要再启动，也不要改端口和 `vite.config.ts` 的 server 配置。**
- `bun run check`：`tsc --noEmit` + `vite build` 编译检查。
- `bun run db:generate`：按 schema 生成迁移；`bun run db:migrate`：执行迁移（启动时也会自动执行）。

## 规则

- 需要持久化的数据一律走 `/api` + SQLite，不要用 localStorage（除非用户明确要求）。迁移只能加表、加列，不能删表、删列、改名——应用数据跨版本保留。
- 前端一律用相对路径请求 `/api/...`，不要写绝对地址或端口。
- 界面用 shadcn 组件和 Tailwind，贴合需求主题，完整可用，适配窄屏。不要留默认模板页、占位按钮或半成品。
- Canvas 小游戏：用 `requestAnimationFrame` 游戏循环；用键盘事件监听控制；维护开始 / 进行中 / 结束 / 重新开始状态；组件卸载时取消动画帧并移除监听。
- 修改 schema 后必须跑 `bun run db:generate` 生成迁移，迁移文件要提交。
- 完成前自己跑 `bun run check` 确保通过，并用 `curl -sf localhost:5173/` 和相关 `/api/...` 的 GET 接口自测（只读，见平台规则）。

## 需求清单

在 `docs/requirements.md` 里维护用户需求清单：每轮把新需求追加进去、把被推翻的标记作废。未被推翻的要求不能丢，实现时逐条核对。
