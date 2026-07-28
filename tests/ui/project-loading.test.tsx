// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import LoadingProject from "@/app/projects/[projectId]/loading";

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

afterEach(cleanup);

describe("project route loading state", () => {
  it("shows the workbench shell immediately while project data streams", () => {
    render(<LoadingProject />);

    expect(
      screen.getByRole("heading", { name: "Opening project workspace…" }),
    ).toBeVisible();
    expect(
      screen.getByText("Loading the latest project state."),
    ).toBeVisible();
    expect(screen.getByText("You and the Agent")).toBeVisible();
    expect(screen.getByText("Loading project state")).toBeVisible();
    expect(screen.getByRole("main")).toHaveAttribute("aria-busy", "true");
  });
});
