import { argosScreenshot } from "@argos-ci/playwright";
import { expect, test } from "@playwright/test";

// Replaced by the golden-scenario specs in PLAN M5.
test("web placeholder renders", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "PC Supervisor" })).toBeVisible();
  await expect(page.getByTestId("status")).toContainText("not built yet");
  await argosScreenshot(page, "web-placeholder");
});
