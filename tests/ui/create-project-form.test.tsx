// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CreateProjectForm } from "@/components/projects/create-project-form";

const push = vi.fn();
const refresh = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh }),
}));

afterEach(() => {
  cleanup();
  push.mockReset();
  refresh.mockReset();
  vi.unstubAllGlobals();
});

describe("CreateProjectForm", () => {
  it("keeps a clear generated-project transition until the route replaces the form", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        json: async () => ({ project: { id: "project-1" } }),
        ok: true,
      }),
    );
    render(<CreateProjectForm />);

    fireEvent.change(screen.getByLabelText("What do you want to build?"), {
      target: { value: "Build a focused timer" },
    });
    fireEvent.submit(screen.getByRole("button", { name: "Create project" }));

    await waitFor(() =>
      expect(push).toHaveBeenCalledWith("/projects/project-1"),
    );
    expect(refresh).not.toHaveBeenCalled();
    expect(
      screen.getByRole("status", { name: "Project created" }),
    ).toHaveTextContent(
      "Project created. Your request is saved and the Agent is generating the first version.",
    );
    expect(
      screen.getByRole("button", {
        name: "Project created · Opening generator…",
      }),
    ).toBeDisabled();
  });
});
