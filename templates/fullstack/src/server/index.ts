import { Hono } from "hono";
import { runMigrations } from "../db/migrate";

runMigrations();

const app = new Hono();

app.get("/api/health", (c) => c.json({ ok: true }));

// Add more routes under /api/* here. The Vite dev server proxies /api to
// this server, so the frontend always calls relative paths like `/api/todos`.

const port = Number(process.env.PORT ?? 3001);
console.log(`[api] listening on http://localhost:${port}`);

export default {
  port,
  fetch: app.fetch,
};
