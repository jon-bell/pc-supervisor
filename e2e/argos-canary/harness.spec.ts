import { test, expect } from "@playwright/test";
import { argosScreenshot } from "@argos-ci/playwright";

// Synthetic harness only. Never point this at a real HotCRP.
test("harness home page", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("body")).toContainText("PC Supervisor Test Conference");
  await argosScreenshot(page, "harness-home");
});
