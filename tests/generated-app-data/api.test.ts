import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET as listData } from "@/app/api/projects/[projectId]/generated-app-data/route";
import {
  DELETE as deleteData,
  GET as getData,
  PUT as setData,
} from "@/app/api/projects/[projectId]/generated-app-data/[key]/route";
import { getCurrentUser } from "@/lib/auth/session";
import {
  deleteOwnedGeneratedAppData,
  getOwnedGeneratedAppData,
  listOwnedGeneratedAppData,
  setOwnedGeneratedAppData,
} from "@/lib/generated-app-data/repository";

vi.mock("@/lib/auth/session", () => ({ getCurrentUser: vi.fn() }));
vi.mock("@/lib/generated-app-data/repository", () => ({
  deleteOwnedGeneratedAppData: vi.fn(),
  getOwnedGeneratedAppData: vi.fn(),
  listOwnedGeneratedAppData: vi.fn(),
  setOwnedGeneratedAppData: vi.fn(),
}));

const user = {
  createdAt: new Date(),
  id: "owner-1",
  passwordHash: "unused",
  username: "demo",
};
const params = (projectId = "project-1", key = "counter") => ({
  params: Promise.resolve({ key, projectId }),
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getCurrentUser).mockResolvedValue(user);
});

describe("Generated App Data API", () => {
  it("lists Project-scoped records for the authenticated owner", async () => {
    vi.mocked(listOwnedGeneratedAppData).mockResolvedValue([
      { key: "counter", updatedAt: new Date(), value: 2 },
    ]);

    const response = await listData(new Request("http://localhost"), {
      params: Promise.resolve({ projectId: "project-1" }),
    });

    expect(response.status).toBe(200);
    expect(listOwnedGeneratedAppData).toHaveBeenCalledWith("owner-1", "project-1");
    await expect(response.json()).resolves.toMatchObject({
      items: [{ key: "counter", value: 2 }],
    });
  });

  it("gets, sets, and deletes bounded values through the owner-scoped repository", async () => {
    vi.mocked(getOwnedGeneratedAppData).mockResolvedValue({
      projectFound: true,
      value: 2,
    });
    vi.mocked(setOwnedGeneratedAppData).mockResolvedValue(3);
    vi.mocked(deleteOwnedGeneratedAppData).mockResolvedValue(true);

    const getResponse = await getData(new Request("http://localhost"), params());
    const setResponse = await setData(
      new Request("http://localhost", {
        body: JSON.stringify({ value: 3 }),
        headers: { "content-type": "application/json" },
        method: "PUT",
      }),
      params(),
    );
    const deleteResponse = await deleteData(new Request("http://localhost"), params());

    expect(getResponse.status).toBe(200);
    expect(setResponse.status).toBe(200);
    expect(deleteResponse.status).toBe(200);
    expect(getOwnedGeneratedAppData).toHaveBeenCalledWith("owner-1", "project-1", "counter");
    expect(setOwnedGeneratedAppData).toHaveBeenCalledWith("owner-1", "project-1", "counter", 3);
    expect(deleteOwnedGeneratedAppData).toHaveBeenCalledWith("owner-1", "project-1", "counter");
  });

  it("does not reveal data for another Project or persist oversized values", async () => {
    vi.mocked(getOwnedGeneratedAppData).mockResolvedValue({
      projectFound: false,
    });

    const crossProject = await getData(new Request("http://localhost"), params("project-2"));
    const oversized = await setData(
      new Request("http://localhost", {
        body: JSON.stringify({ value: "x".repeat(16_385) }),
        headers: { "content-type": "application/json" },
        method: "PUT",
      }),
      params(),
    );

    expect(crossProject.status).toBe(404);
    expect(getOwnedGeneratedAppData).toHaveBeenCalledWith("owner-1", "project-2", "counter");
    expect(oversized.status).toBe(400);
    expect(setOwnedGeneratedAppData).toHaveBeenCalledTimes(0);
  });

  it("accepts JSON null as a valid stored value", async () => {
    vi.mocked(setOwnedGeneratedAppData).mockResolvedValue(null);
    vi.mocked(getOwnedGeneratedAppData).mockResolvedValue({
      projectFound: true,
      value: null,
    });

    const response = await setData(
      new Request("http://localhost", {
        body: JSON.stringify({ value: null }),
        headers: { "content-type": "application/json" },
        method: "PUT",
      }),
      params(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ value: null });

    const getResponse = await getData(
      new Request("http://localhost"),
      params(),
    );
    expect(getResponse.status).toBe(200);
    await expect(getResponse.json()).resolves.toEqual({ value: null });
  });
});
