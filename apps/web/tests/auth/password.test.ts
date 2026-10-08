import { describe, expect, it } from "vitest";

import { hashPassword, verifyPassword } from "@/lib/auth/password";

describe("password authentication", () => {
  it("stores a salted bcrypt hash that verifies the original password", async () => {
    const password = "test-password-for-auth";
    const hash = await hashPassword(password);

    expect(hash).toMatch(/^\$2[aby]\$12\$/);
    expect(hash).not.toContain(password);
    expect(await verifyPassword(password, hash)).toBe(true);
    expect(await verifyPassword("wrong-password", hash)).toBe(false);
  });
});
