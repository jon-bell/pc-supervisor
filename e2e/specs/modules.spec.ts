// PLAN M11 smoke: the "Modules" nav group and the reserve-compliance and
// quick-reject views render over golden (a discussion-phase scenario with no
// extended phase dates, so neither module is active and neither has a window).
// The planted-problem checks live in the registration integration test.
import { expect, test } from "@playwright/test";

test("the Modules nav group links to both module views", async ({ page }) => {
  await page.goto("/");
  const group = page.getByTestId("nav-modules");
  await expect(group).toContainText("Modules");
  await group.getByRole("link", { name: "Reserve" }).click();
  await expect(page).toHaveURL(/\/modules\/reserve$/);
  await expect(page.getByRole("heading", { name: "Reserve compliance" })).toBeVisible();
  await group.getByRole("link", { name: "Quick reject" }).click();
  await expect(page).toHaveURL(/\/modules\/quickreject$/);
  await expect(page.getByRole("heading", { name: "Quick-reject tracker" })).toBeVisible();
});

test("reserve view: phase window, counts, and the paper table", async ({ page }) => {
  await page.goto("/modules/reserve");
  const w = page.getByTestId("module-window");
  await expect(w).toHaveAttribute("data-active", "0");
  await expect(w).toContainText("Module A");
  await expect(w).toContainText("no window");
  await expect(page.getByTestId("reserve-counts")).toContainText("12 papers");
  await expect(page.getByTestId("reserve-papers")).toBeVisible();
});

test("quick-reject view: phase window and an empty queue", async ({ page }) => {
  await page.goto("/modules/quickreject");
  const w = page.getByTestId("module-window");
  await expect(w).toHaveAttribute("data-active", "0");
  await expect(w).toContainText("Module B");
  await expect(page.getByTestId("qr-counts")).toContainText("0 papers in the queue");
  await expect(page.getByTestId("module-notes")).toContainText("PCS_PHASE_QUICKREJECT_DUE is not set");
});
