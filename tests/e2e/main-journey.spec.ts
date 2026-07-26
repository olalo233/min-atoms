import { expect, test, type Page } from "@playwright/test";

import { getE2eEnvironment } from "./environment";

const e2eEnvironment = getE2eEnvironment();

function preview(page: Page) {
  return page.frameLocator('iframe[title="Interactive generated preview"]');
}

async function expectActiveVersion(page: Page, version: number) {
  await expect(page.getByRole("status")).toContainText("Preview ready", {
    timeout: 30_000,
  });
  await expect(page.getByText(`Artifact Version ${version}`, { exact: true })).toBeVisible();
}

test.describe("Demo User main journey", () => {
  test.describe.configure({ mode: "serial" });

  test("does not expose public registration routes", async ({ page, request }) => {
    const registrationPage = await page.goto("/register");
    expect(registrationPage?.status()).toBe(404);

    const registrationApi = await request.post("/api/auth/register");
    expect(registrationApi.status()).toBe(404);
  });

  test("creates, evolves, restores, and reopens a Project without losing generated data", async ({ page }) => {
    const request = `Counter acceptance ${Date.now()}`;

    await page.goto("/login");
    await page.getByLabel("Username").fill(e2eEnvironment.DEMO_USERNAME);
    await page.getByLabel("Password").fill(e2eEnvironment.DEMO_PASSWORD);
    await page.getByRole("button", { name: "Open workspace" }).click();
    await expect(page).toHaveURL(/\/workspace$/);

    await page.getByLabel("What do you want to build?").fill(
      `${request}: make an incrementing counter whose value survives reload.`,
    );
    await page.getByRole("button", { name: "Create project" }).click();
    await expect(page).toHaveURL(/\/projects\//);

    await expectActiveVersion(page, 1);
    await expect(preview(page).locator("#count")).toHaveText("0");

    const projectId = new URL(page.url()).pathname.split("/").at(-1);
    expect(projectId).toBeTruthy();
    const repeatedGeneration = await page.request.post(
      `/api/projects/${projectId}/generation`,
    );
    expect(repeatedGeneration.status()).toBe(202);
    await expect(repeatedGeneration.json()).resolves.toMatchObject({
      job: { status: "completed" },
      versions: [{ version: 1 }],
    });

    const persistedCounter = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        response.url().endsWith("/generated-app-data/counter") &&
        response.ok(),
    );
    await preview(page).getByRole("button", { name: "Add one" }).click();
    await expect(preview(page).locator("#count")).toHaveText("1");
    await persistedCounter;

    await page.reload();
    await expectActiveVersion(page, 1);
    await expect(preview(page).locator("#count")).toHaveText("1");

    await page.getByLabel("Describe the next change").fill(
      "Keep the counter and label this as a second immutable version.",
    );
    await page.getByRole("button", { name: "Generate from v1" }).click();
    await expectActiveVersion(page, 2);
    await expect(preview(page).locator("#count")).toHaveText("1");

    await page.getByRole("button", { name: /^v1\b/ }).click();
    await expect(page.getByText("Artifact Version 1", { exact: true })).toBeVisible();
    await expect(preview(page).locator("#count")).toHaveText("1");

    await page.reload();
    await expectActiveVersion(page, 2);
    await expect(preview(page).locator("#count")).toHaveText("1");

    await page.getByRole("button", { name: /^v1\b/ }).click();
    const restoredVersion = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith("/restore") &&
        response.ok(),
    );
    await page.getByRole("button", { name: "Restore v1 as active" }).click();
    await restoredVersion;
    await expect(page.getByRole("button", { name: /^v1 · active$/ })).toBeVisible();

    await page.getByRole("link", { name: "← Workspace" }).click();
    await expect(page).toHaveURL(/\/workspace$/);
    await page.getByRole("link", { name: new RegExp(request) }).click();
    await expect(page).toHaveURL(/\/projects\//);
    await expectActiveVersion(page, 1);
    await expect(page.getByRole("button", { name: /^v1 · active$/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /^v2$/ })).toBeVisible();
    await expect(preview(page).locator("#count")).toHaveText("1");
  });
});
