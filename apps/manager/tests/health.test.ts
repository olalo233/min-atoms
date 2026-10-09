import { expect, test } from "bun:test";
import { ManagerHealthResponseSchema } from "@min-atoms/protocol";
import { harness, id, label } from "./helpers";

test("health is public and counts only running projects with matching DB, labels and mounts", async () => {
  const h = await harness();
  try {
    h.docker.add(h.store.add(1), h.root);
    h.docker.add(h.store.add(2), h.root, false);
    const foreign = h.docker.add({ id: id(3), previewLabel: label(3) }, h.root);
    foreign.labels = {};
    const forged = h.docker.add(h.store.add(4), h.root);
    forged.mounts[0].Source = "/unrelated/workspace";
    const response = await h.app.request("/health");
    expect(response.status).toBe(200);
    expect(ManagerHealthResponseSchema.parse(await response.json())).toEqual({ ok: true, version: "0.1.0", containers: 1 });
    expect(h.docker.commands.every(argv => !argv.includes("ma-gateway") && !argv.includes("unrelated"))).toBe(true);
    expect(h.docker.commands.some(argv => argv[1] === "stop")).toBe(false);
  } finally { await h.cleanup(); }
});

test("health reports an unavailable runtime instead of a fabricated zero", async () => {
  const h = await harness();
  try {
    h.docker.unavailable = true;
    expect((await h.app.request("/health")).status).toBe(503);
  } finally { await h.cleanup(); }
});
