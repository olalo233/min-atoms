import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  DELETE as deleteProject,
  GET as getProject,
} from "@/app/api/projects/[projectId]/route";
import { POST as createProject } from "@/app/api/projects/route";
import { getCurrentUser } from "@/lib/auth/session";
import { runGenerationJob } from "@/lib/generation/worker";
import {
  createProjectWithBuildRequest,
  deleteOwnedProject,
  getOwnedProject,
} from "@/lib/projects/repository";

// `after()` from next/server must run its callback after the response. In a unit
// test there is no Next runtime, so capture scheduled callbacks and let each
// test flush them to prove the response resolved before the worker ran.
const afterState = vi.hoisted(() => ({
  after: vi.fn(),
  callbacks: [] as Array<() => unknown>,
}));

vi.mock("@/lib/auth/session", () => ({
  getCurrentUser: vi.fn(),
}));

vi.mock("@/lib/projects/repository", () => ({
  createProjectWithBuildRequest: vi.fn(),
  deleteOwnedProject: vi.fn(),
  getOwnedProject: vi.fn(),
  listOwnedProjects: vi.fn(),
}));

vi.mock("@/lib/generation/worker", () => ({
  runGenerationJob: vi.fn(),
}));

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal() as typeof import("next/server");
  return {
    ...actual,
    after(callback: () => unknown) {
      afterState.after(callback);
      afterState.callbacks.push(callback);
    },
  };
});

const mockedGetCurrentUser = vi.mocked(getCurrentUser);
const mockedCreateProject = vi.mocked(createProjectWithBuildRequest);
const mockedDeleteOwnedProject = vi.mocked(deleteOwnedProject);
const mockedGetOwnedProject = vi.mocked(getOwnedProject);
const mockedRunGenerationJob = vi.mocked(runGenerationJob);

function flushAfterCallbacks(): Promise<unknown[]> {
  const callbacks = afterState.callbacks.splice(0);
  return Promise.all(callbacks.map((callback) => callback()));
}

const authenticatedOwner = {
  id: "owner-2",
  username: "other",
  passwordHash: "unused",
  createdAt: new Date(),
};

beforeEach(() => {
  vi.clearAllMocks();
  afterState.callbacks.length = 0;
});

describe("project API boundaries", () => {
  it("does not persist a whitespace-only request", async () => {
    mockedGetCurrentUser.mockResolvedValue({
      id: "owner-1",
      username: "demo",
      passwordHash: "unused",
      createdAt: new Date(),
    });

    const response = await createProject(
      new Request("http://localhost/api/projects", {
        body: JSON.stringify({ buildRequest: " \n\t " }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );

    expect(response.status).toBe(400);
    expect(mockedCreateProject).not.toHaveBeenCalled();
  });

  it("creates through the owner-scoped repository and schedules generation after the response", async () => {
    mockedGetCurrentUser.mockResolvedValue({
      id: "owner-1",
      username: "demo",
      passwordHash: "unused",
      createdAt: new Date(),
    });
    mockedCreateProject.mockResolvedValue({
      project: {
        id: "project-1",
        ownerId: "owner-1",
        name: "Project: Make a timer",
        activeArtifactVersionId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      buildRequest: {
        id: "request-1",
        projectId: "project-1",
        content: "Make a timer",
        baseVersionId: null,
        createdAt: new Date(),
      },
      job: {
        id: "job-1",
        projectId: "project-1",
        buildRequestId: "request-1",
        baseVersionId: null,
        status: "queued",
        errorMessage: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        completedAt: null,
      },
    });

    const response = await createProject(
      new Request("http://localhost/api/projects", {
        body: JSON.stringify({ buildRequest: "Make a timer" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );

    expect(response.status).toBe(201);
    expect(mockedCreateProject).toHaveBeenCalledWith("owner-1", "Make a timer");
    await expect(response.json()).resolves.toMatchObject({
      project: { id: "project-1" },
      buildRequest: { projectId: "project-1" },
    });
    // The response resolved before any DeepSeek work ran.
    expect(mockedRunGenerationJob).not.toHaveBeenCalled();
    expect(afterState.after).toHaveBeenCalledTimes(1);

    await flushAfterCallbacks();
    expect(mockedRunGenerationJob).toHaveBeenCalledWith("job-1");
  });

  it("passes the authenticated owner into detail lookup", async () => {
    mockedGetCurrentUser.mockResolvedValue({
      id: "owner-2",
      username: "other",
      passwordHash: "unused",
      createdAt: new Date(),
    });
    mockedGetOwnedProject.mockResolvedValue(null);

    const response = await getProject(new Request("http://localhost"), {
      params: Promise.resolve({ projectId: "project-1" }),
    });

    expect(response.status).toBe(404);
    expect(mockedGetOwnedProject).toHaveBeenCalledWith("owner-2", "project-1");
  });

  it("requires authentication before deleting a project", async () => {
    mockedGetCurrentUser.mockResolvedValue(null);

    const response = await deleteProject(
      new Request("http://localhost", { method: "DELETE" }),
      { params: Promise.resolve({ projectId: "project-1" }) },
    );

    expect(response.status).toBe(401);
    expect(mockedDeleteOwnedProject).not.toHaveBeenCalled();
  });

  it("returns 404 when the owned project does not exist", async () => {
    mockedGetCurrentUser.mockResolvedValue({
      id: "owner-1",
      username: "demo",
      passwordHash: "unused",
      createdAt: new Date(),
    });
    mockedDeleteOwnedProject.mockResolvedValue("not found");

    const response = await deleteProject(
      new Request("http://localhost", { method: "DELETE" }),
      { params: Promise.resolve({ projectId: "missing" }) },
    );

    expect(response.status).toBe(404);
    expect(mockedDeleteOwnedProject).toHaveBeenCalledWith("owner-1", "missing");
  });

  it("rejects deletion with 409 while a generation job is active", async () => {
    mockedGetCurrentUser.mockResolvedValue({
      id: "owner-1",
      username: "demo",
      passwordHash: "unused",
      createdAt: new Date(),
    });
    mockedDeleteOwnedProject.mockResolvedValue("active");

    const response = await deleteProject(
      new Request("http://localhost", { method: "DELETE" }),
      { params: Promise.resolve({ projectId: "project-1" }) },
    );

    expect(response.status).toBe(409);
  });

  it("deletes the owned project with no active jobs and returns 204", async () => {
    mockedGetCurrentUser.mockResolvedValue({
      id: "owner-1",
      username: "demo",
      passwordHash: "unused",
      createdAt: new Date(),
    });
    mockedDeleteOwnedProject.mockResolvedValue("deleted");

    const response = await deleteProject(
      new Request("http://localhost", { method: "DELETE" }),
      { params: Promise.resolve({ projectId: "project-1" }) },
    );

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(mockedDeleteOwnedProject).toHaveBeenCalledWith("owner-1", "project-1");
  });
});

describe("project deletion boundary", () => {
  it("rejects deletion without an authenticated session", async () => {
    mockedGetCurrentUser.mockResolvedValue(null);

    const response = await deleteProject(
      new Request("http://localhost", { method: "DELETE" }),
      { params: Promise.resolve({ projectId: "project-1" }) },
    );

    expect(response.status).toBe(401);
    expect(mockedDeleteOwnedProject).not.toHaveBeenCalled();
  });

  it("returns 404 when the owner has no matching project", async () => {
    mockedGetCurrentUser.mockResolvedValue(authenticatedOwner);
    mockedDeleteOwnedProject.mockResolvedValue("not found");

    const response = await deleteProject(
      new Request("http://localhost", { method: "DELETE" }),
      { params: Promise.resolve({ projectId: "project-1" }) },
    );

    expect(response.status).toBe(404);
    expect(mockedDeleteOwnedProject).toHaveBeenCalledWith(
      "owner-2",
      "project-1",
    );
  });

  it("returns 409 and leaves the project intact while a generation job is active", async () => {
    mockedGetCurrentUser.mockResolvedValue(authenticatedOwner);
    mockedDeleteOwnedProject.mockResolvedValue("active");

    const response = await deleteProject(
      new Request("http://localhost", { method: "DELETE" }),
      { params: Promise.resolve({ projectId: "project-1" }) },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.any(String),
    });
  });

  it("deletes the inactive project and responds 204 with an empty body", async () => {
    mockedGetCurrentUser.mockResolvedValue(authenticatedOwner);
    mockedDeleteOwnedProject.mockResolvedValue("deleted");

    const response = await deleteProject(
      new Request("http://localhost", { method: "DELETE" }),
      { params: Promise.resolve({ projectId: "project-1" }) },
    );

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(mockedDeleteOwnedProject).toHaveBeenCalledWith(
      "owner-2",
      "project-1",
    );
  });
});
