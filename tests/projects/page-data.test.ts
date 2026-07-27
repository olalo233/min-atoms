import { beforeEach, describe, expect, it, vi } from "vitest";

import { getDb } from "@/lib/db/client";
import { getOwnedProjectPageSeed } from "@/lib/projects/page-data";

vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));

const mockedGetDb = vi.mocked(getDb);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("project page data", () => {
  it("loads the owned project, initial request, latest job, and active artifact in one query", async () => {
    const seed = {
      artifactVersion: null,
      buildRequest: {
        baseVersionId: null,
        content: "Build a timer.",
        createdAt: new Date("2026-07-27T00:00:00.000Z"),
        id: "request-1",
        projectId: "project-1",
      },
      job: null,
      project: {
        activeArtifactVersionId: null,
        createdAt: new Date("2026-07-27T00:00:00.000Z"),
        id: "project-1",
        name: "Project: Build a timer",
        ownerId: "owner-1",
        updatedAt: new Date("2026-07-27T00:00:00.000Z"),
      },
    };
    const executeLimit = vi.fn().mockResolvedValue([seed]);
    const leftJoinArtifact = vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ limit: executeLimit }),
    });
    const leftJoinJob = vi.fn().mockReturnValue({
      leftJoin: leftJoinArtifact,
    });
    const innerJoinBuildRequest = vi.fn().mockReturnValue({
      leftJoinLateral: leftJoinJob,
    });
    const subquery = (alias: string) => {
      const as = vi.fn().mockReturnValue({ alias });
      const limit = vi.fn().mockReturnValue({ as });
      const orderBy = vi.fn().mockReturnValue({ limit });
      const where = vi.fn().mockReturnValue({ orderBy });
      return { from: vi.fn().mockReturnValue({ where }) };
    };
    const finalQuery = {
      from: vi.fn().mockReturnValue({
        innerJoinLateral: innerJoinBuildRequest,
      }),
    };
    const database = {
      select: vi
        .fn()
        .mockReturnValueOnce(subquery("initial_build_request"))
        .mockReturnValueOnce(subquery("latest_generation_job"))
        .mockReturnValueOnce(finalQuery),
    };
    mockedGetDb.mockReturnValue(database as never);

    await expect(
      getOwnedProjectPageSeed("owner-1", "project-1"),
    ).resolves.toEqual(seed);

    expect(database.select).toHaveBeenCalledTimes(3);
    expect(executeLimit).toHaveBeenCalledOnce();
    expect(innerJoinBuildRequest).toHaveBeenCalledTimes(1);
    expect(leftJoinJob).toHaveBeenCalledTimes(1);
    expect(leftJoinArtifact).toHaveBeenCalledTimes(1);
  });
});
