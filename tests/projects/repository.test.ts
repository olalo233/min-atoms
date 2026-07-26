import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  deleteOwnedProject,
  getInitialProjectName,
  normalizeBuildRequest,
  retryOwnedGeneration,
} from "@/lib/projects/repository";
import { getDb } from "@/lib/db/client";
import { createGenerationJob } from "@/lib/generation/repository";

vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/generation/repository", () => ({ createGenerationJob: vi.fn() }));

const mockedGetDb = vi.mocked(getDb);
const mockedCreateGenerationJob = vi.mocked(createGenerationJob);

function latestJobQuery(job: { buildRequestId: string; projectId: string; baseVersionId: string | null; status: string }) {
  const limit = vi.fn().mockResolvedValue([{ job }]);
  const orderBy = vi.fn().mockReturnValue({ limit });
  const where = vi.fn().mockReturnValue({ orderBy });
  const innerJoin = vi.fn().mockReturnValue({ where });
  const from = vi.fn().mockReturnValue({ innerJoin });
  return { select: vi.fn().mockReturnValue({ from }) };
}

function deleteOwnedProjectHarness(options: { found: boolean; active: boolean }) {
  const operations: string[] = [];
  let selectCount = 0;
  const transaction = {
    execute: vi.fn(async () => {
      operations.push("lock");
    }),
    select: vi.fn(() => {
      selectCount += 1;
      const isFirst = selectCount === 1;
      const rows = isFirst
        ? options.found
          ? [{ id: "project-1", activeArtifactVersionId: "version-1" }]
          : []
        : options.active
          ? [{ id: "job-1" }]
          : [];
      const limit = vi.fn(async () => rows);
      const where = vi.fn(() =>
        isFirst ? { limit } : { orderBy: vi.fn(() => ({ limit })) },
      );
      return { from: vi.fn(() => ({ where })) };
    }),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(async () => {
          operations.push("clear");
        }),
      })),
    })),
    delete: vi.fn(() => ({
      where: vi.fn(async () => {
        operations.push("delete");
      }),
    })),
  };
  mockedGetDb.mockReturnValue({
    transaction: vi.fn((callback) => callback(transaction)),
  } as never);
  return { operations, transaction };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("project request contracts", () => {
  it("trims boundary whitespace while preserving the request body", () => {
    expect(normalizeBuildRequest("  Make  a\n timer  ")).toBe("Make  a\n timer");
  });

  it("rejects whitespace-only content before persistence", () => {
    expect(normalizeBuildRequest(" \n\t ")).toBe("");
  });

  it("derives a deterministic useful name from the request", () => {
    expect(getInitialProjectName("  Make  a\n timer  ")).toBe(
      "Project: Make a timer",
    );
  });

  it("limits long names without changing the stored request contract", () => {
    const request = "a".repeat(100);
    expect(getInitialProjectName(request)).toBe(`Project: ${"a".repeat(72)}`);
  });

  it.each(["queued", "planning", "generating", "validating", "repairing", "completed"])("returns a %s job instead of creating another version for a repeated generation POST", async (status) => {
    const completedJob = {
      baseVersionId: "version-1",
      buildRequestId: "request-1",
      id: "job-1",
      projectId: "project-1",
      status,
    };
    mockedGetDb.mockReturnValue(latestJobQuery(completedJob) as never);

    await expect(retryOwnedGeneration("owner-1", "project-1")).resolves.toBe(completedJob);

    expect(mockedCreateGenerationJob).not.toHaveBeenCalled();
  });

  it("creates a retry only when the latest generation failed", async () => {
    const failedJob = {
      baseVersionId: "version-1",
      buildRequestId: "request-1",
      projectId: "project-1",
      status: "failed",
    };
    const retriedJob = { ...failedJob, id: "job-2", status: "queued" };
    mockedGetDb.mockReturnValue(latestJobQuery(failedJob) as never);
    mockedCreateGenerationJob.mockResolvedValue(retriedJob as never);

    await expect(retryOwnedGeneration("owner-1", "project-1")).resolves.toBe(retriedJob);

    expect(mockedCreateGenerationJob).toHaveBeenCalledWith(
      "project-1",
      "request-1",
      "version-1",
    );
  });

  it("creates a retry when the latest generation was cancelled", async () => {
    const cancelledJob = {
      baseVersionId: "version-1",
      buildRequestId: "request-1",
      projectId: "project-1",
      status: "cancelled",
    };
    const requeuedJob = { ...cancelledJob, id: "job-2", status: "queued" };
    mockedGetDb.mockReturnValue(latestJobQuery(cancelledJob) as never);
    mockedCreateGenerationJob.mockResolvedValue(requeuedJob as never);

    await expect(retryOwnedGeneration("owner-1", "project-1")).resolves.toBe(requeuedJob);

    expect(mockedCreateGenerationJob).toHaveBeenCalledWith(
      "project-1",
      "request-1",
      "version-1",
    );
  });
});

describe("owned project deletion", () => {
  it("deletes an inactive owned project under one project lock and clears the active version", async () => {
    const harness = deleteOwnedProjectHarness({ found: true, active: false });

    await expect(
      deleteOwnedProject("owner-1", "project-1"),
    ).resolves.toBe("deleted");

    expect(harness.operations).toEqual(["lock", "clear", "delete"]);
    expect(harness.transaction.execute).toHaveBeenCalledTimes(1);
    expect(harness.transaction.update).toHaveBeenCalledTimes(1);
    expect(harness.transaction.delete).toHaveBeenCalledTimes(1);
  });

  it("rejects deletion and leaves the project intact while a generation job is active", async () => {
    const harness = deleteOwnedProjectHarness({ found: true, active: true });

    await expect(
      deleteOwnedProject("owner-1", "project-1"),
    ).resolves.toBe("active");

    expect(harness.operations).toEqual(["lock"]);
    expect(harness.transaction.update).not.toHaveBeenCalled();
    expect(harness.transaction.delete).not.toHaveBeenCalled();
  });

  it("reports not found when the owner does not own the project", async () => {
    const harness = deleteOwnedProjectHarness({ found: false, active: false });

    await expect(
      deleteOwnedProject("owner-1", "project-1"),
    ).resolves.toBe("not found");

    expect(harness.operations).toEqual(["lock"]);
    expect(harness.transaction.select).toHaveBeenCalledTimes(1);
    expect(harness.transaction.delete).not.toHaveBeenCalled();
  });
});
