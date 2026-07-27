// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ProjectList } from "@/components/projects/project-list";

const { prefetchMock } = vi.hoisted(() => ({
  prefetchMock: vi.fn(),
}));

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    prefetch,
    ...rest
  }: {
    children: ReactNode;
    href: string;
    prefetch?: boolean;
  }) => (
    <a data-prefetch={String(prefetch)} href={href} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ prefetch: prefetchMock }),
}));

const projects = [
  { id: "project-1", name: "Project: A daily water tracker", updatedLabel: "7/26/2026" },
  { id: "project-2", name: "Project: A compact counter", updatedLabel: "7/25/2026" },
];

afterEach(() => {
  cleanup();
  prefetchMock.mockClear();
  vi.unstubAllGlobals();
});

describe("ProjectList", () => {
  it("guides the next step when no projects exist yet", () => {
    render(<ProjectList projects={[]} />);

    expect(screen.getByText("No projects yet")).toBeVisible();
    expect(
      screen.getByText(/describe your first build above/i),
    ).toBeVisible();
  });

  it("asks for confirmation before deleting a project", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(<ProjectList projects={projects} />);

    fireEvent.click(screen.getAllByRole("button", { name: "Delete" })[0]);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Confirm delete" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Keep project" })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Keep project" }));
    expect(
      screen.queryByRole("button", { name: "Confirm delete" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Project: A daily water tracker")).toBeVisible();
  });

  it("prefetches a project when the user shows intent to open it", () => {
    render(<ProjectList projects={projects} />);

    const firstProject = screen.getAllByRole("link")[0];
    expect(firstProject).toHaveAttribute("data-prefetch", "false");
    fireEvent.pointerEnter(firstProject);
    fireEvent.focus(firstProject);

    expect(prefetchMock).toHaveBeenCalledOnce();
    expect(prefetchMock).toHaveBeenCalledWith("/projects/project-1");
  });

  it("removes the project after a confirmed delete", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    vi.stubGlobal("fetch", fetchMock);

    render(<ProjectList projects={projects} />);

    fireEvent.click(screen.getAllByRole("button", { name: "Delete" })[0]);
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/projects/project-1", {
        method: "DELETE",
      });
    });
    await waitFor(() => {
      expect(
        screen.queryByText("Project: A daily water tracker"),
      ).not.toBeInTheDocument();
    });
    expect(screen.getByText("Project: A compact counter")).toBeVisible();
  });

  it("keeps the project and explains when the server refuses to delete", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue({
        error: "Stop the active agent before deleting this project.",
      }),
      ok: false,
      status: 409,
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ProjectList projects={projects} />);

    fireEvent.click(screen.getAllByRole("button", { name: "Delete" })[0]);
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Stop the active agent before deleting this project.",
    );
    expect(screen.getByText("Project: A daily water tracker")).toBeVisible();
    expect(screen.getAllByRole("link")).toHaveLength(2);
  });
});
