import { expect, test } from "bun:test";
import { app } from "../src/app";

test("health is public and reports an empty manager", async () => {
  const response = await app.request("/health");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true, version: "0.1.0", containers: 0 });
});

test("business endpoints are not implemented in the skeleton", async () => {
  expect((await app.request("/projects/example/ensure", { method: "POST" })).status).toBe(404);
});
