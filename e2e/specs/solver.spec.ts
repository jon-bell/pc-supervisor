// PLAN M10b smoke: the "Assignment" (M10's validator) and "Solver" module
// views render over golden (a discussion-phase scenario: its reviews are
// written, so the solver keeps them pinned). Running the solver only reads
// HotCRP (conflicts, preferences). The planted-problem checks live in
// seed/test/integration/solver.test.ts.
import { expect, test } from "@playwright/test";

test("the Modules nav group links to the assignment validator and the solver", async ({ page }) => {
  await page.goto("/");
  const group = page.getByTestId("nav-modules");
  await group.getByRole("link", { name: "Assignment" }).click();
  await expect(page).toHaveURL(/\/modules\/assignment$/);
  await expect(page.getByRole("heading", { name: "Assignment validator" })).toBeVisible();
  await group.getByRole("link", { name: "Solver" }).click();
  await expect(page).toHaveURL(/\/modules\/solver$/);
  await expect(page.getByRole("heading", { name: "Assignment solver" })).toBeVisible();
});

test("assignment view: module C window, findings with reasons, and the fix-up CSV", async ({ page }) => {
  await page.goto("/modules/assignment");
  await expect(page.getByTestId("module-window")).toContainText("Module C");
  await expect(page.getByTestId("assignment-counts")).toContainText(/Current HotCRP assignment \(last sync\): \d+ papers/);
  await expect(page.getByTestId("assignment-finding").first()).toContainText(/\d/);
  await expect(page.getByTestId("assignment-csv")).toContainText("paper,action,user");
  // No TPMS import in golden: the TPMS mode says how to get one.
  await page.getByTestId("assignment-source-tpms").click();
  await expect(page.getByText("pcs import tpms-assignments")).toBeVisible();
});

test("solver view: run a solve and read its report", async ({ page }) => {
  await page.goto("/modules/solver");
  await expect(page.getByTestId("solver-empty")).toBeVisible();
  await page.getByTestId("solver-run").click();
  const summary = page.getByTestId("solver-summary");
  await expect(summary).toContainText("Soft solve", { timeout: 60_000 });
  await expect(summary).toHaveAttribute("data-feasible", "1");
  await expect(summary).toContainText(/\d+ papers, \d+ reviewers/);
  await expect(page.getByTestId("solver-load").locator("tr[data-tier=senior]")).toBeVisible();
  await expect(page.getByTestId("solver-crosscheck")).toContainText("0 unexplained");
  await expect(page.getByTestId("solver-csv")).toContainText("paper,action,email,round");
  // The cached report survives a reload.
  await page.reload();
  await expect(page.getByTestId("solver-summary")).toContainText("Soft solve");
});
