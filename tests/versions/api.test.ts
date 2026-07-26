import { beforeEach, describe, expect, it, vi } from "vitest";

import { POST as followUp } from "@/app/api/projects/[projectId]/follow-up/route";
import {
  DELETE as cancelGeneration,
  POST as retryGeneration,
} from "@/app/api/projects/[projectId]/generation/route";
import { GET as listVersions } from "@/app/api/projects/[projectId]/versions/route";
import { GET as getVersion } from "@/app/api/projects/[projectId]/versions/[versionId]/route";
import { POST as restoreVersion } from "@/app/api/projects/[projectId]/versions/[versionId]/restore/route";
import { getCurrentUser } from "@/lib/auth/session";
import {
  cancelOwnedGeneration,
  getOwnedArtifactVersion,
  getOwnedGenerationSnapshot,
  listOwnedArtifactVersions,
  restoreOwnedArtifactVersion,
} from "@/lib/generation/repository";
import {
  createOwnedFollowUpGeneration,
  retryOwnedGeneration,
} from "@/lib/projects/repository";
import { runGenerationJob } from "@/lib/generation/worker";

vi.mock("@/lib/auth/session", () => ({ getCurrentUser: vi.fn() }));
vi.mock("@/lib/generation/repository", () => ({
  cancelOwnedGeneration: vi.fn(),
  getOwnedArtifactVersion: vi.fn(),
  getOwnedGenerationSnapshot: vi.fn(),
  listOwnedArtifactVersions: vi.fn(),
  restoreOwnedArtifactVersion: vi.fn(),
}));
vi.mock("@/lib/projects/repository", () => ({
  createOwnedFollowUpGeneration: vi.fn(),
  retryOwnedGeneration: vi.fn(),
}));
vi.mock("@/lib/generation/worker", () => ({ runGenerationJob: vi.fn() }));

const owner = {
  createdAt: new Date("2026-07-26T00:00:00.000Z"),
  id: "owner-1",
  passwordHash: "unused",
  username: "demo",
};
const context = { params: Promise.resolve({ projectId: "project-1", versionId: "11111111-1111-4111-8111-111111111111" }) };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getCurrentUser).mockResolvedValue(owner);
});

describe("version API contracts", () => {
  it("persists cancellation through an owner-scoped terminal transition", async () => {
    vi.mocked(cancelOwnedGeneration).mockResolvedValue(true);
    vi.mocked(getOwnedGenerationSnapshot).mockResolvedValue({
      artifactVersion: null,
      events: [{ createdAt: "2026-07-26T00:00:00.000Z", id: "event-cancelled", message: "Generation cancelled.", sequence: 2, stage: "cancelled" }],
      job: null,
      versions: [],
    });

    const response = await cancelGeneration(
      new Request("http://localhost", { method: "DELETE" }),
      { params: Promise.resolve({ projectId: "project-1" }) },
    );

    expect(response.status).toBe(200);
    expect(cancelOwnedGeneration).toHaveBeenCalledWith("owner-1", "project-1");
    await expect(response.json()).resolves.toMatchObject({
      events: [expect.objectContaining({ stage: "cancelled" })],
    });
  });

  it("creates a follow-up through one owner-scoped request-and-job seam", async () => {
    vi.mocked(createOwnedFollowUpGeneration).mockResolvedValue({
      buildRequest: { baseVersionId: "11111111-1111-4111-8111-111111111111", content: "Celebrate it", createdAt: new Date(), id: "request-2", projectId: "project-1" },
      job: { id: "job-2" } as never,
    });
    vi.mocked(getOwnedGenerationSnapshot).mockResolvedValue({ artifactVersion: null, events: [], job: null, versions: [] });

    const response = await followUp(new Request("http://localhost", {
      body: JSON.stringify({ baseVersionId: "11111111-1111-4111-8111-111111111111", buildRequest: "Celebrate it" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }), { params: Promise.resolve({ projectId: "project-1" }) });

    expect(response.status).toBe(202);
    expect(createOwnedFollowUpGeneration).toHaveBeenCalledWith(
      "owner-1",
      "project-1",
      "Celebrate it",
      "11111111-1111-4111-8111-111111111111",
    );
    expect(runGenerationJob).toHaveBeenCalledWith("job-2");
  });

  it("keeps the retry request alive until the generation worker finishes", async () => {
    vi.mocked(retryOwnedGeneration).mockResolvedValue({ id: "job-retry" } as never);
    vi.mocked(getOwnedGenerationSnapshot).mockResolvedValue({
      artifactVersion: null,
      events: [],
      job: null,
      versions: [],
    });
    let finishWorker: (() => void) | undefined;
    vi.mocked(runGenerationJob).mockReturnValue(
      new Promise<void>((resolve) => {
        finishWorker = resolve;
      }),
    );

    const responsePromise = retryGeneration(
      new Request("http://localhost", { method: "POST" }),
      { params: Promise.resolve({ projectId: "project-1" }) },
    );
    const beforeWorkerFinished = await Promise.race([
      responsePromise.then(() => "resolved"),
      new Promise<"waiting">((resolve) => {
        setTimeout(() => resolve("waiting"), 10);
      }),
    ]);

    expect(beforeWorkerFinished).toBe("waiting");
    expect(getOwnedGenerationSnapshot).not.toHaveBeenCalled();
    finishWorker?.();
    const response = await responsePromise;

    expect(response.status).toBe(202);
    expect(runGenerationJob).toHaveBeenCalledWith("job-retry");
    expect(getOwnedGenerationSnapshot).toHaveBeenCalledWith(
      "owner-1",
      "project-1",
    );
  });

  it("does not expose a version outside the authenticated owner's Project", async () => {
    vi.mocked(getOwnedArtifactVersion).mockResolvedValue(null);

    const response = await getVersion(new Request("http://localhost"), context);

    expect(response.status).toBe(404);
    expect(getOwnedArtifactVersion).toHaveBeenCalledWith(
      "owner-1",
      "project-1",
      "11111111-1111-4111-8111-111111111111",
    );
    expect(restoreOwnedArtifactVersion).not.toHaveBeenCalled();
  });

  it("lists successful versions only through the owner-scoped lookup", async () => {
    vi.mocked(listOwnedArtifactVersions).mockResolvedValue(null);

    const response = await listVersions(new Request("http://localhost"), {
      params: Promise.resolve({ projectId: "project-1" }),
    });

    expect(response.status).toBe(404);
    expect(listOwnedArtifactVersions).toHaveBeenCalledWith("owner-1", "project-1");
  });

  it("returns a selected version without restore mutation", async () => {
    vi.mocked(getOwnedArtifactVersion).mockResolvedValue({
      createdAt: new Date("2026-07-26T00:00:00.000Z"),
      files: {
        "app.js": "",
        "index.html": '<button id="increment">Add one</button><output id="count">0</output>',
        "manifest.json": JSON.stringify({ entry: "index.html", smoke: { action: "click", expect: { selector: "#count", text: "1" }, selector: "#increment" } }),
        "styles.css": "",
      },
      id: "11111111-1111-4111-8111-111111111111",
      jobId: "job-1",
      projectId: "project-1",
      version: 1,
    });

    const response = await getVersion(new Request("http://localhost"), context);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ artifactVersion: { version: 1 } });
    expect(restoreOwnedArtifactVersion).not.toHaveBeenCalled();
  });

  it("restores only through the explicit owner-scoped action", async () => {
    vi.mocked(restoreOwnedArtifactVersion).mockResolvedValue({ id: "version-1" } as never);
    vi.mocked(getOwnedGenerationSnapshot).mockResolvedValue({ artifactVersion: null, events: [], job: null, versions: [] });

    const response = await restoreVersion(new Request("http://localhost", { method: "POST" }), context);

    expect(response.status).toBe(200);
    expect(restoreOwnedArtifactVersion).toHaveBeenCalledWith(
      "owner-1",
      "project-1",
      "11111111-1111-4111-8111-111111111111",
    );
  });
});
