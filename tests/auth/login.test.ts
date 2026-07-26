import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));

import { getDb } from "@/lib/db/client";
import { authenticateUser } from "@/lib/auth/login";
import { hashPassword } from "@/lib/auth/password";

const mockedGetDb = vi.mocked(getDb);

function userLookup(result: unknown[]) {
  const limit = vi.fn().mockResolvedValue(result);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  return { select: vi.fn().mockReturnValue({ from }) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("seeded-user authentication seam", () => {
  it("authenticates against a randomly salted bcrypt hash held by the stored user", async () => {
    const password = "demo-password";
    const storedHash = await hashPassword(password);
    const anotherHashForTheSamePassword = await hashPassword(password);
    const storedUser = {
      createdAt: new Date("2026-07-26T00:00:00.000Z"),
      id: "user-1",
      passwordHash: storedHash,
      username: "demo",
    };
    mockedGetDb.mockReturnValue(userLookup([storedUser]) as never);

    await expect(authenticateUser("demo", password)).resolves.toEqual(storedUser);
    expect(storedHash).toMatch(/^\$2[aby]\$12\$/);
    expect(storedHash).not.toBe(anotherHashForTheSamePassword);
    expect(storedHash).not.toContain(password);
  });
});
