import { beforeEach, describe, expect, it, vi } from "vitest";

import { getDb } from "@/lib/db/client";
import {
  claimGenerationJob,
  createGenerationJob,
  failGenerationJob,
  getProjectGenerationSnapshot,
  getOwnedGenerationSnapshot,
  persistGenerationAttempt,
  queueOwnedRuntimeRepair,
  requeueGenerationForRevalidation,
  updateGenerationStatus,
} from "@/lib/generation/repository";

vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));

const mockedGetDb = vi.mocked(getDb);

function transitionHarness(updateWins: boolean) {
  const operations: string[] = [];
  let selectCount = 0;
  const transaction = {
    execute: vi.fn(async () => {
      operations.push("lock");
    }),
    insert: vi.fn(() => ({
      values: vi.fn(async (value: { stage: string }) => {
        operations.push(`event:${value.stage}`);
      }),
    })),
    select: vi.fn(() => {
      selectCount += 1;
      if (selectCount === 1) {
        return {
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn(async () => [{ projectId: "project-1" }]),
            })),
          })),
        };
      }
      return {
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            orderBy: vi.fn(() => ({
              limit: vi.fn(async () => [{ sequence: 3 }]),
            })),
          })),
        })),
      };
    }),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(async () => {
            operations.push("status");
            return updateWins ? [{ id: "job-1" }] : [];
          }),
        })),
      })),
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

describe("generation status and event serialization", () => {
  it("loads streamed generation details in one parallel query wave", async () => {
    const files = {
      "app.js": "",
      "index.html": "<main>Ready</main>",
      "manifest.json": JSON.stringify({
        entry: "index.html",
        ui: { preset: "min-atoms-base" },
      }),
      "styles.css": "",
    };
    const job = {
      baseVersionId: null,
      buildRequestId: "request-1",
      completedAt: new Date("2026-07-27T00:01:00.000Z"),
      createdAt: new Date("2026-07-27T00:00:00.000Z"),
      errorMessage: null,
      id: "job-1",
      projectId: "project-1",
      status: "completed" as const,
      updatedAt: new Date("2026-07-27T00:01:00.000Z"),
    };
    const artifact = {
      createdAt: new Date("2026-07-27T00:01:00.000Z"),
      files,
      id: "version-1",
      jobId: "job-1",
      projectId: "project-1",
      version: 1,
    };
    const rows = [
      Promise.resolve([
        {
          createdAt: new Date("2026-07-27T00:01:00.000Z"),
          id: "event-1",
          jobId: "job-1",
          message: "Version 1 is ready in Preview.",
          sequence: 1,
          stage: "completed",
        },
      ]),
      Promise.resolve([
        {
          createdAt: new Date("2026-07-27T00:01:00.000Z"),
          id: "version-1",
          version: 1,
        },
      ]),
    ];
    let selectCount = 0;
    const database = {
      select: vi.fn(() => {
        const index = selectCount;
        selectCount += 1;
        const chain: Record<string, unknown> = {};
        chain.from = vi.fn(() => chain);
        chain.where = vi.fn(() => chain);
        chain.orderBy = vi.fn(() => rows[index]);
        return chain;
      }),
    };
    mockedGetDb.mockReturnValue(database as never);

    await expect(
      getProjectGenerationSnapshot(job, artifact),
    ).resolves.toMatchObject({
      artifactVersion: { id: "version-1" },
      events: [{ id: "event-1" }],
      job: { id: "job-1" },
      versions: [{ id: "version-1" }],
    });
    expect(database.select).toHaveBeenCalledTimes(2);
  });

  it("loads project identity and snapshot parts in parallel without historical files", async () => {
    function deferred<T>() {
      let resolve!: (value: T) => void;
      const promise = new Promise<T>((complete) => {
        resolve = complete;
      });
      return { promise, resolve };
    }

    const ownedProject = deferred<Array<{ id: string }>>();
    const latestJob = deferred<
      Array<{
        baseVersionId: null;
        buildRequestId: string;
        completedAt: Date;
        createdAt: Date;
        errorMessage: null;
        id: string;
        projectId: string;
        status: "completed";
        updatedAt: Date;
      }>
    >();
    const selections: Array<Record<string, unknown> | undefined> = [];
    let selectCount = 0;
    const files = {
      "app.js": "",
      "index.html": "<main>Ready</main>",
      "manifest.json": JSON.stringify({
        entry: "index.html",
        ui: { preset: "min-atoms-base" },
      }),
      "styles.css": "",
    };
    const rows = [
      ownedProject.promise,
      latestJob.promise,
      Promise.resolve([
        {
          createdAt: new Date("2026-07-27T00:00:00.000Z"),
          id: "event-1",
          jobId: "job-1",
          message: "Version 1 is ready in Preview.",
          sequence: 1,
          stage: "completed",
        },
      ]),
      Promise.resolve([
        {
          artifact: {
            createdAt: new Date("2026-07-27T00:00:00.000Z"),
            files,
            id: "version-1",
            jobId: "job-1",
            projectId: "project-1",
            version: 1,
          },
        },
      ]),
      Promise.resolve([
        {
          createdAt: new Date("2026-07-27T00:00:00.000Z"),
          id: "version-1",
          version: 1,
        },
      ]),
    ];
    const database = {
      select: vi.fn((selection?: Record<string, unknown>) => {
        const index = selectCount;
        selectCount += 1;
        selections.push(selection);
        const chain: Record<string, unknown> = {};
        chain.from = vi.fn(() => chain);
        chain.innerJoin = vi.fn(() => chain);
        chain.where = vi.fn(() => chain);
        chain.limit = vi.fn(() => rows[index]);
        chain.orderBy = vi.fn(() =>
          index === 1 ? { limit: vi.fn(() => rows[index]) } : rows[index],
        );
        return chain;
      }),
    };
    mockedGetDb.mockReturnValue(database as never);

    const snapshotPromise = getOwnedGenerationSnapshot(
      "owner-1",
      "project-1",
    );
    expect(database.select).toHaveBeenCalledTimes(2);

    ownedProject.resolve([{ id: "project-1" }]);
    latestJob.resolve([
      {
        baseVersionId: null,
        buildRequestId: "request-1",
        completedAt: new Date("2026-07-27T00:00:00.000Z"),
        createdAt: new Date("2026-07-27T00:00:00.000Z"),
        errorMessage: null,
        id: "job-1",
        projectId: "project-1",
        status: "completed",
        updatedAt: new Date("2026-07-27T00:00:00.000Z"),
      },
    ]);

    await expect(snapshotPromise).resolves.toMatchObject({
      artifactVersion: { id: "version-1" },
      versions: [{ id: "version-1", version: 1 }],
    });
    expect(database.select).toHaveBeenCalledTimes(5);
    expect(selections[4]).toEqual({
      createdAt: expect.anything(),
      id: expect.anything(),
      version: expect.anything(),
    });
    expect(selections[4]).not.toHaveProperty("files");
  });

  it("creates the queued job and first event inside one project-locked transaction", async () => {
    const operations: string[] = [];
    let insertCount = 0;
    const transaction = {
      execute: vi.fn(async () => {
        operations.push("lock");
      }),
      insert: vi.fn(() => {
        insertCount += 1;
        if (insertCount === 1) {
          return {
            values: vi.fn(() => ({
              onConflictDoNothing: vi.fn(() => ({
                returning: vi.fn(async () => {
                  operations.push("job:queued");
                  return [{ id: "job-1", status: "queued" }];
                }),
              })),
            })),
          };
        }
        return {
          values: vi.fn(async (value: { stage: string }) => {
            operations.push(`event:${value.stage}`);
          }),
        };
      }),
    };
    mockedGetDb.mockReturnValue({
      transaction: vi.fn((callback) => callback(transaction)),
    } as never);

    await expect(
      createGenerationJob("project-1", "request-1"),
    ).resolves.toMatchObject({ id: "job-1", status: "queued" });

    expect(operations).toEqual(["lock", "job:queued", "event:queued"]);
    expect(transaction.insert).toHaveBeenCalledTimes(2);
  });

  it("persists a claimed status and its event under one project lock", async () => {
    const harness = transitionHarness(true);

    await expect(claimGenerationJob("job-1")).resolves.toBe(true);

    expect(harness.operations).toEqual(["lock", "status", "event:planning"]);
    expect(harness.transaction.insert).toHaveBeenCalledTimes(1);
  });

  it("does not append a later worker event when cancellation wins the expected-state check", async () => {
    const harness = transitionHarness(false);

    await expect(
      updateGenerationStatus(
        "job-1",
        "planning",
        "generating",
        "Generating the constrained four-file artifact.",
      ),
    ).resolves.toBe(false);

    expect(harness.operations).toEqual(["lock", "status"]);
    expect(harness.transaction.insert).not.toHaveBeenCalled();
  });

  it("persists a stable failure code and a safe actionable Generation Event", async () => {
    const insertedEvents: Array<{ message: string; stage: string }> = [];
    let selectCount = 0;
    let persistedErrorMessage = "";
    const transaction = {
      execute: vi.fn(async () => undefined),
      insert: vi.fn(() => ({
        values: vi.fn(async (value: { message: string; stage: string }) => {
          insertedEvents.push(value);
        }),
      })),
      select: vi.fn(() => {
        selectCount += 1;
        if (selectCount === 1) {
          return {
            from: vi.fn(() => ({
              where: vi.fn(() => ({
                limit: vi.fn(async () => [{ projectId: "project-1" }]),
              })),
            })),
          };
        }
        return {
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              orderBy: vi.fn(() => ({
                limit: vi.fn(async () => [{ sequence: 6 }]),
              })),
            })),
          })),
        };
      }),
      update: vi.fn(() => ({
        set: vi.fn((value: { errorMessage: string }) => {
          persistedErrorMessage = value.errorMessage;
          return {
            where: vi.fn(() => ({
              returning: vi.fn(async () => [{ id: "job-1" }]),
            })),
          };
        }),
      })),
    };
    mockedGetDb.mockReturnValue({
      transaction: vi.fn((callback) => callback(transaction)),
    } as never);

    await failGenerationJob(
      "job-1",
      "artifact_invalid",
      "Artifact manifest must satisfy the required contract.",
    );

    expect(persistedErrorMessage).toBe("artifact_invalid");
    expect(insertedEvents).toHaveLength(1);
    expect(insertedEvents[0]).toMatchObject({
        message:
          "Artifact rejected: Artifact manifest must satisfy the required contract.",
        stage: "failed",
    });
  });

  it("persists one rejected candidate before transitioning the job to repairing", async () => {
    const inserted: unknown[] = [];
    let selectCount = 0;
    let persistedStatus = "";
    const transaction = {
      execute: vi.fn(async () => undefined),
      insert: vi.fn(() => ({
        values: vi.fn(async (value: unknown) => {
          inserted.push(value);
        }),
      })),
      select: vi.fn(() => {
        selectCount += 1;
        const rows =
          selectCount === 1
            ? [{ projectId: "project-1" }]
            : selectCount === 2
              ? [{ status: "validating" }]
              : selectCount === 3
                ? [{ sequence: 2 }]
                : [{ sequence: 8 }];
        return {
          from: vi.fn(() => ({
            where: vi.fn(() =>
              selectCount >= 3
                ? {
                    orderBy: vi.fn(() => ({
                      limit: vi.fn(async () => rows),
                    })),
                  }
                : { limit: vi.fn(async () => rows) },
            ),
          })),
        };
      }),
      update: vi.fn(() => ({
        set: vi.fn((value: { status: string }) => {
          persistedStatus = value.status;
          return {
            where: vi.fn(() => ({
              returning: vi.fn(async () => [{ id: "job-1" }]),
            })),
          };
        }),
      })),
    };
    mockedGetDb.mockReturnValue({
      transaction: vi.fn((callback) => callback(transaction)),
    } as never);
    const candidate = {
      "app.js": "",
      "index.html": "",
      "manifest.json": "{}",
      "styles.css": "",
    };

    await expect(
      persistGenerationAttempt({
        candidateFiles: candidate,
        diagnostic: "Artifact manifest must satisfy the required contract.",
        expectedStatus: "validating",
        jobId: "job-1",
        kind: "generate",
        outcome: "rejected",
      }),
    ).resolves.toBe("repairing");

    expect(persistedStatus).toBe("repairing");
    expect(inserted[0]).toMatchObject({
      candidateFiles: candidate,
      diagnostic: "Artifact manifest must satisfy the required contract.",
      jobId: "job-1",
      sequence: 3,
    });
    expect(inserted[1]).toMatchObject({
      message:
        "Attempt 3 rejected: Artifact manifest must satisfy the required contract. Waiting for the next incremental repair.",
      stage: "repairing",
    });
  });

  it("requeues the active completed version with a real-browser diagnostic and persisted candidate", async () => {
    const files = {
      "app.js": "requestAnimationFrame(() => undefined);",
      "index.html": '<canvas id="game"></canvas>',
      "manifest.json": JSON.stringify({
        entry: "index.html",
        ui: { preset: "min-atoms-base" },
      }),
      "styles.css": "",
    };
    const inserted: unknown[] = [];
    let selected = 0;
    let updatedStatus = "";
    const transaction = {
      execute: vi.fn(async () => undefined),
      insert: vi.fn(() => ({
        values: vi.fn(async (value: unknown) => {
          inserted.push(value);
        }),
      })),
      select: vi.fn(() => {
        selected += 1;
        const rows =
          selected === 1
            ? [
                {
                  activeArtifactVersionId: "version-1",
                  artifact: {
                    files,
                    id: "version-1",
                    jobId: "job-1",
                    projectId: "project-1",
                  },
                  job: {
                    id: "job-1",
                    projectId: "project-1",
                    status: "completed",
                  },
                },
              ]
            : selected === 2
              ? []
              : selected === 3
                ? [{ sequence: 2 }]
                : [{ sequence: 8 }];
        const chain: Record<string, unknown> = {};
        chain.innerJoin = vi.fn(() => chain);
        chain.where = vi.fn(() => ({
          limit: vi.fn(async () => rows),
          orderBy: vi.fn(() => ({
            limit: vi.fn(async () => rows),
          })),
        }));
        chain.from = vi.fn(() => chain);
        return chain;
      }),
      update: vi.fn(() => ({
        set: vi.fn((value: { status: string }) => {
          updatedStatus = value.status;
          return {
            where: vi.fn(() => ({
              returning: vi.fn(async () => [{ id: "job-1" }]),
            })),
          };
        }),
      })),
    };
    mockedGetDb.mockReturnValue({
      transaction: vi.fn((callback) => callback(transaction)),
    } as never);

    await expect(
      queueOwnedRuntimeRepair(
        "owner-1",
        "project-1",
        "version-1",
        "error: gameLoop is not defined",
      ),
    ).resolves.toEqual({ jobId: "job-1", queued: true });

    expect(updatedStatus).toBe("repairing");
    expect(inserted[0]).toMatchObject({
      candidateFiles: files,
      diagnostic:
        "Real browser Preview failed at runtime: error: gameLoop is not defined",
      jobId: "job-1",
      kind: "repair",
      outcome: "rejected",
      sequence: 3,
    });
    expect(inserted[1]).toMatchObject({
      jobId: "job-1",
      stage: "repairing",
    });
  });

  it("requeues an artifact-invalid job and records platform revalidation", async () => {
    let selectCount = 0;
    const insertedEvents: Array<{ message: string; stage: string }> = [];
    const requeuedJob = {
      errorMessage: "artifact_invalid",
      id: "job-1",
      projectId: "project-1",
      status: "repairing",
    };
    const transaction = {
      execute: vi.fn(async () => undefined),
      insert: vi.fn(() => ({
        values: vi.fn(async (value: { message: string; stage: string }) => {
          insertedEvents.push(value);
        }),
      })),
      select: vi.fn(() => {
        selectCount += 1;
        const rows =
          selectCount === 1
            ? [{ projectId: "project-1" }]
            : [{ sequence: 32 }];
        return {
          from: vi.fn(() => ({
            where: vi.fn(() =>
              selectCount === 1
                ? { limit: vi.fn(async () => rows) }
                : {
                    orderBy: vi.fn(() => ({
                      limit: vi.fn(async () => rows),
                    })),
                  },
            ),
          })),
        };
      }),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({
            returning: vi.fn(async () => [requeuedJob]),
          })),
        })),
      })),
    };
    mockedGetDb.mockReturnValue({
      transaction: vi.fn((callback) => callback(transaction)),
    } as never);

    await expect(
      requeueGenerationForRevalidation("job-1"),
    ).resolves.toBe(requeuedJob);
    expect(insertedEvents).toHaveLength(1);
    expect(insertedEvents[0]).toMatchObject({
      message: "Latest persisted candidate queued for platform revalidation.",
      stage: "repairing",
    });
  });
});
