Bun.serve({
  hostname: "127.0.0.1",
  port: 8090,
  fetch(request) {
    const path = new URL(request.url).pathname;
    return path === "/health"
      ? Response.json({ ok: true, version: "health-stub", containers: 0 })
      : new Response("Not found", { status: 404 });
  },
});
