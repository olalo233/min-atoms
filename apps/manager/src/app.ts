import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import {
  ManagerDeleteResponseSchema, ManagerEnsureRequestSchema, ManagerEnsureResponseSchema,
  ManagerHealthResponseSchema, verifySseToken,
} from "@min-atoms/protocol";
import { ManagerError, validateProjectId } from "./errors";
import { DurableEvents, eventStream, type HeartbeatTimers } from "./events";
import type { ManagerStore } from "./store";
import type { ProjectRuntime } from "./runtime";

export function createManagerApp(options: {
  secret: string; webOrigin: string; store: ManagerStore; runtime: ProjectRuntime;
  events: DurableEvents; now?: () => number; timers?: HeartbeatTimers;
}) {
  const app = new Hono();
  const secret = Buffer.from(`Bearer ${options.secret}`);
  const now = options.now ?? Date.now;
  let lastActivity = now();
  let openStreams = 0;
  const activity = () => { lastActivity = now(); };
  app.onError((error, c) => error instanceof ManagerError
    ? c.json({ error: error.message }, error.status)
    : c.json({ error: "Manager operation failed" }, 503));

  // CORS applies only to the browser event endpoint, including error responses.
  app.use("/projects/:id/stream", async (c, next) => {
    c.header("Vary", "Origin");
    if (c.req.header("Origin") === options.webOrigin) {
      c.header("Access-Control-Allow-Origin", options.webOrigin);
      c.header("Access-Control-Allow-Methods", "GET");
    }
    await next();
  });
  app.options("/projects/:id/stream", c => c.body(null, 204));
  app.use("/projects/*", async (c, next) => {
    if (c.req.method === "GET" && /^\/projects\/[^/]+\/stream$/.test(c.req.path)) return next();
    const actual = Buffer.from(c.req.header("Authorization") ?? "");
    if (actual.length !== secret.length || !timingSafeEqual(actual, secret)) return c.json({ error: "Unauthorized" }, 401);
    activity();
    await next();
  });

  app.get("/health", async c => {
    const [containers, activeRuns] = await Promise.all([options.runtime.count(), options.store.hasActiveRuns()]);
    const idleSeconds = activeRuns || openStreams > 0 ? 0
      : Math.max(0, Math.floor((now() - Math.max(lastActivity, options.events.lastRunFinishedAt ?? lastActivity)) / 1000));
    return c.json(ManagerHealthResponseSchema.parse({ ok: true, version: "0.1.0", containers, idleSeconds }));
  });
  app.post("/projects/:id/ensure", async c => {
    validateProjectId(c.req.param("id"));
    const body = ManagerEnsureRequestSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!body.success) throw new ManagerError(400, "Invalid ensure body");
    await options.runtime.ensure(c.req.param("id"), body.data.previewLabel);
    return c.json(ManagerEnsureResponseSchema.parse({ ready: true }));
  });
  app.delete("/projects/:id", async c => {
    await options.runtime.remove(c.req.param("id"));
    return c.json(ManagerDeleteResponseSchema.parse({}));
  });
  app.get("/projects/:id/shots/:filename", async c => {
    const id = c.req.param("id");
    await options.runtime.project(id);
    const match = /^([0-9a-f]{40})\.png$/.exec(c.req.param("filename"));
    if (!match) throw new ManagerError(400, "Invalid commit SHA filename");
    const image = await options.runtime.files.shot(id, match[1]);
    if (!image) return c.body(null, 404);
    c.header("Content-Type", "image/png");
    return c.body(new Uint8Array(image));
  });
  app.get("/projects/:id/stream", async c => {
    const id = c.req.param("id");
    validateProjectId(id);
    if (!await verifySseToken(c.req.query("token") ?? "", id, options.secret, options.now?.() ?? Date.now())) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    const raw = c.req.query("after") ?? "0";
    const after = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(after) || after < 0) throw new ManagerError(400, "Invalid event cursor");
    const project = await options.runtime.project(id);
    c.header("Content-Type", "text/event-stream");
    c.header("Cache-Control", "no-cache");
    openStreams++;
    activity();
    return c.body(eventStream({
      projectId: project.id, after, events: options.events, store: options.store,
      signal: c.req.raw.signal, timers: options.timers,
      onClose() { openStreams--; activity(); },
    }));
  });
  return app;
}
