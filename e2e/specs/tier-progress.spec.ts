// PLAN M12 views against golden (PCS_NOW 2030-02-26, tiers junior and
// reciprocal, no early-reject window configured): the Modules nav group,
// reviewing progress by tier (R-recip's late reciprocal review on #2 is a
// reserve dropout needing a replacement), and the early-reject page's
// not-configured state. The window logic itself is asserted by the
// `earlyreject` integration test.
import { expect, test } from "@playwright/test";
import { P } from "@pcs/seed/scenarios/golden/scenario";

test.describe("Modules nav", () => {
  test("lists the reviewing-by-tier and early-reject views", async ({ page }) => {
    await page.goto("/");
    const nav = page.getByTestId("nav-modules");
    await expect(nav).toContainText("Modules");
    await nav.getByRole("link", { name: "Reviewing by tier" }).click();
    await expect(page).toHaveURL(/\/modules\/tier-progress$/);
    await expect(page.getByTestId("tier-progress")).toBeVisible();
    await nav.getByRole("link", { name: "Early reject" }).click();
    await expect(page).toHaveURL(/\/modules\/early-reject$/);
  });
});

test.describe("Reviewing progress by tier", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/modules/tier-progress");
    await expect(page.getByTestId("tier-row")).toHaveCount(3);
  });

  test("late reviews by tier: only the reciprocal review on #2", async ({ page }) => {
    const row = (tier: string) => page.locator(`[data-testid="tier-row"][data-tier="${tier}"]`);
    await expect(row("reciprocal").getByTestId("tier-late")).toHaveText("1");
    await expect(row("senior").getByTestId("tier-late")).toHaveText("0");
    await expect(row("junior").getByTestId("tier-late")).toHaveText("0");
  });

  test("reserve dropout: R-recip on #2 needs a replacement; accountability is worded as evidence", async ({ page }) => {
    const d = page.locator(`[data-testid="dropout-row"][data-key="${P.recip}@2"]`);
    await expect(d.getByTestId("dropout-state")).toHaveAttribute("data-state", "replacement-needed");
    await expect(d).toContainText("24.5 days");
    await expect(page.getByTestId("dropout-row")).toHaveCount(1);
    await expect(page.getByTestId("accountability-note")).toContainText("Evidence for a human decision");
    await expect(page.locator(`[data-testid="accountability-row"][data-email="${P.recip}"]`).getByTestId("acct-late")).toHaveText("1 open · 0 after");
  });

  test("the coaching queue is empty (golden's junior reviews are 250 words) and withholding is off", async ({ page }) => {
    await expect(page.getByTestId("coaching-row")).toHaveCount(0);
    await expect(page.getByText("No reviews in the coaching queue.")).toBeVisible();
    await expect(page.getByTestId("withhold")).toContainText("PCS_POLICY_WITHHOLD_REVIEWS is off");
  });

  test("participation by tier is shown once discussion has opened", async ({ page }) => {
    const junior = page.locator('[data-testid="participation-row"][data-tier="junior"]');
    // R-silent (junior) never comments.
    await expect(junior).toContainText("0/1");
    await expect(junior).toContainText("0/3 papers · 0%");
  });
});

test.describe("Early reject", () => {
  test("says how to configure the window when it is unset", async ({ page }) => {
    await page.goto("/modules/early-reject");
    await expect(page.getByTestId("er-window")).toHaveAttribute("data-status", "unconfigured");
    await expect(page.getByTestId("er-window")).toContainText("PCS_PHASE_EARLYREJECT_OPEN");
    await expect(page.getByTestId("candidate-row")).toHaveCount(0);
  });
});
