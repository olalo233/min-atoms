import { beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "@/app/api/projects/[projectId]/messages/route";
import { getCurrentUser } from "@/lib/auth/session";
import { requestConversationReply } from "@/lib/generation/deepseek";
import { getOwnedGenerationSnapshot } from "@/lib/generation/repository";
import { runGenerationJob } from "@/lib/generation/worker";
import {
  appendOwnedAssistantMessage,
  appendOwnedChatUserMessage,
  getOwnedProjectMessages,
} from "@/lib/projects/messages";
import { createOwnedFollowUpGeneration } from "@/lib/projects/repository";

const afterState = vi.hoisted(() => ({
  callbacks: [] as Array<() => unknown>,
}));

vi.mock("@/lib/auth/session", () => ({ getCurrentUser: vi.fn() }));
vi.mock("@/lib/generation/deepseek", () => ({
  requestConversationReply: vi.fn(),
}));
vi.mock("@/lib/generation/repository", () => ({
  getOwnedGenerationSnapshot: vi.fn(),
}));
vi.mock("@/lib/generation/worker", () => ({ runGenerationJob: vi.fn() }));
vi.mock("@/lib/projects/messages", () => ({
  appendOwnedAssistantMessage: vi.fn(),
  appendOwnedChatUserMessage: vi.fn(),
  getOwnedProjectMessages: vi.fn(),
}));
vi.mock("@/lib/projects/repository", () => ({
  createOwnedFollowUpGeneration: vi.fn(),
}));
vi.mock("next/server", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("next/server");
  return {
    ...actual,
    after(callback: () => unknown) {
      afterState.callbacks.push(callback);
    },
  };
});

const user = {
  createdAt: new Date(),
  id: "owner-1",
  passwordHash: "unused",
  username: "demo",
};
const firstBuild = {
  artifactVersionId: null,
  buildRequestId: "request-1",
  content: "Build a snake game.",
  createdAt: "2026-07-27T00:00:00.000Z",
  id: "message-1",
  mode: "build" as const,
  role: "user" as const,
  sequence: 1,
};
const chatQuestion = {
  ...firstBuild,
  buildRequestId: null,
  content: "Should it use canvas?",
  id: "message-2",
  mode: "chat" as const,
  sequence: 2,
};
const chatReply = {
  ...chatQuestion,
  content: "Canvas is a good fit for the playfield.",
  id: "message-3",
  role: "assistant" as const,
  sequence: 3,
};

beforeEach(() => {
  vi.clearAllMocks();
  afterState.callbacks.length = 0;
  vi.mocked(getCurrentUser).mockResolvedValue(user);
});

describe("project conversation API", () => {
  it("persists the user turn, sends the complete history, and persists the reply", async () => {
    vi.mocked(appendOwnedChatUserMessage).mockResolvedValue(chatQuestion);
    vi.mocked(getOwnedProjectMessages)
      .mockResolvedValueOnce([firstBuild, chatQuestion])
      .mockResolvedValueOnce([firstBuild, chatQuestion, chatReply]);
    vi.mocked(requestConversationReply).mockResolvedValue(chatReply.content);
    vi.mocked(appendOwnedAssistantMessage).mockResolvedValue(chatReply);

    const response = await POST(
      new Request("http://localhost", {
        body: JSON.stringify({
          content: "Should it use canvas?",
          mode: "chat",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      { params: Promise.resolve({ projectId: "project-1" }) },
    );

    expect(response.status).toBe(200);
    expect(appendOwnedChatUserMessage).toHaveBeenCalledWith(
      "owner-1",
      "project-1",
      "Should it use canvas?",
    );
    expect(requestConversationReply).toHaveBeenCalledWith([
      firstBuild,
      chatQuestion,
    ]);
    expect(appendOwnedAssistantMessage).toHaveBeenCalledWith(
      "owner-1",
      "project-1",
      chatReply.content,
      "chat",
    );
    await expect(response.json()).resolves.toEqual({
      messages: [firstBuild, chatQuestion, chatReply],
    });
  });

  it("persists a Build Mode turn and schedules artifact generation after responding", async () => {
    vi.mocked(createOwnedFollowUpGeneration).mockResolvedValue({
      buildRequest: {
        baseVersionId: "00000000-0000-4000-8000-000000000001",
        content: "Add keyboard controls.",
        createdAt: new Date(),
        id: "request-2",
        projectId: "project-1",
      },
      job: { id: "job-2" },
    } as never);
    vi.mocked(getOwnedGenerationSnapshot).mockResolvedValue({
      artifactVersion: null,
      events: [],
      job: null,
      versions: [],
    });
    vi.mocked(getOwnedProjectMessages).mockResolvedValue([
      firstBuild,
      {
        ...chatQuestion,
        content: "Add keyboard controls.",
        id: "message-4",
        mode: "build",
      },
    ]);

    const response = await POST(
      new Request("http://localhost", {
        body: JSON.stringify({
          baseVersionId: "00000000-0000-4000-8000-000000000001",
          content: "Add keyboard controls.",
          mode: "build",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      { params: Promise.resolve({ projectId: "project-1" }) },
    );

    expect(response.status).toBe(202);
    expect(createOwnedFollowUpGeneration).toHaveBeenCalledWith(
      "owner-1",
      "project-1",
      "Add keyboard controls.",
      "00000000-0000-4000-8000-000000000001",
    );
    expect(runGenerationJob).not.toHaveBeenCalled();
    expect(afterState.callbacks).toHaveLength(1);

    await afterState.callbacks[0]?.();
    expect(runGenerationJob).toHaveBeenCalledWith("job-2");
  });
});
