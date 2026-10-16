import { expect, test } from "bun:test";
import { ManagerHealthResponseSchema } from "../src";

test("health accepts older responses and optional nonnegative integer idleSeconds", () => {
  const health = { ok: true, version: "0.1.0", containers: 0 };
  expect(ManagerHealthResponseSchema.parse(health)).toEqual(health);
  for (const idleSeconds of [0, 1800]) {
    expect(ManagerHealthResponseSchema.parse({ ...health, idleSeconds }).idleSeconds).toBe(idleSeconds);
  }
  for (const idleSeconds of [-1, 0.5, "1800", null]) {
    expect(ManagerHealthResponseSchema.safeParse({ ...health, idleSeconds }).success).toBe(false);
  }
});
