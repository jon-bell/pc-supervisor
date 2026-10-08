// Discussion leads (chair feedback) against golden: one row per lead with
// their papers, review progress, comments and whether they commented, the
// per-lead drill-down, the empty state, and Argos baselines. Also the
// tier-less UI: with PCS_TIER_TAGS empty (simulated by answering /api/meta
// with tiersConfigured=false, since the E2E server runs with tiers), no tier
// filter, chip, heading or tier-progress nav entry is shown.
import { argosScreenshot } from "@argos-ci/playwright";
import { expect, test, type Page } from "@playwright/test";
import { P } from "@pcs/seed/scenarios/golden/scenario";
import { PEOPLE } from "@pcs/seed/scenarios/golden/expected";

const leadRow = (page: Page, email: string) => page.locator(`[data-testid="lead-row"][data-email="${email}"]`);
const ready = async (page: Page) => expect(page.getByTestId("sync-status")).toHaveAttribute("data-running", "false");

test.describe("discussion leads", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/leads");
    await expect(page.getByTestId("lead-row")).toHaveCount(Object.keys(PEOPLE.leads).length);
  });

  test("one row per lead, alphabetical, with papers, reviews, comments and their own comments", async ({ page }) => {
    // Alphabetical by name, not a ranking.
    await expect(page.getByTestId("lead-name")).toHaveText(["Ben Brookvale", "Charlie Champlain", "Eli Elmsworth"]);
    await expect(page.locator("main")).toContainText("6 of 13 papers have a lead.");
    for (const [email, want] of Object.entries(PEOPLE.leads)) {
      const row = leadRow(page, email);
      await expect(row.getByTestId("lead-load")).toHaveAttribute("data-load", String(want.pids.length));
      await expect(row.getByTestId("lead-commented")).toHaveAttribute("data-commented", String(want.commented.length));
    }
    // R-champ never comments on pid 8: spec §7 wording.
    await expect(leadRow(page, P.champ).getByTestId("lead-commented")).toHaveText("no comments yet");
    await expect(leadRow(page, P.ben).getByTestId("lead-commented")).toHaveText("on 2 of 3 papers · not yet on #11");
    // pid 8: three submitted reviews.
    await expect(leadRow(page, P.champ).getByTestId("lead-reviews")).toHaveText("3/3 submitted");
    await expect(page.locator("body")).not.toContainText(/leaderboard|disengaged|worst/i);
  });

  test("clicking a lead opens their papers; a paper opens its drawer", async ({ page }) => {
    await leadRow(page, P.ben).click();
    await expect(page).toHaveURL(/\/leads\/r-ben%40example\.org$/);
    await expect(page.getByTestId("lead-page-name")).toHaveText("Ben Brookvale");
    await expect(page.getByTestId("lead-paper")).toHaveCount(PEOPLE.leads[P.ben].pids.length);
    const pids = await page.getByTestId("lead-paper").evaluateAll((els) => els.map((e) => Number(e.getAttribute("data-pid"))));
    expect(pids).toEqual([...PEOPLE.leads[P.ben].pids]);
    const p11 = page.locator('[data-testid="lead-paper"][data-pid="11"]');
    await expect(p11.getByTestId("lp-lead")).toHaveText("no comments yet");
    await expect(p11.locator('[data-testid="chip"][data-rule="RESPONSE_UNADDRESSED"]')).toBeVisible();
    await ready(page);
    await argosScreenshot(page, "lead-detail");
    await page.locator('[data-testid="lead-paper"][data-pid="3"]').click();
    await expect(page).toHaveURL(/\/papers\/3$/);
  });

  test("the nav has a Leads entry", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("nav").getByRole("link", { name: "Leads" }).click();
    await expect(page).toHaveURL(/\/leads$/);
    await expect(page.getByTestId("lead-table")).toBeVisible();
  });

  test("the paper filter applies: a search with no led papers shows the empty state", async ({ page }) => {
    await page.goto("/leads?search=5%207");
    await expect(page.getByTestId("leads-empty")).toContainText("No paper has a discussion lead yet (0 of 2 papers).");
  });

  test("screenshot: lead table", async ({ page }) => {
    await ready(page);
    await argosScreenshot(page, "lead-table");
  });
});

test.describe("no tiers configured", () => {
  test.beforeEach(async ({ page }) => {
    await page.route("**/api/meta", async (route) => {
      const r = await route.fetch();
      const meta = (await r.json()) as Record<string, unknown>;
      await route.fulfill({ response: r, json: { ...meta, tiers: ["senior"], tiersConfigured: false } });
    });
  });

  test("hides the tier filter, the tier-progress nav and view, tier labels and headings", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("triage-row").first()).toBeVisible();
    await expect(page.getByTestId("filter-tier")).toHaveCount(0);
    await expect(page.getByTestId("nav-modules").getByRole("link", { name: /tier/i })).toHaveCount(0);
    await page.goto("/modules/tier-progress");
    await expect(page.getByTestId("no-tiers")).toBeVisible();
    await page.goto(`/people/${encodeURIComponent(P.silent)}`);
    await expect(page.getByTestId("person-name")).toBeVisible();
    await expect(page.getByTestId("person-tier")).toHaveCount(0);
    await page.goto("/reviewers");
    await expect(page.getByTestId("outlier-list").first()).toBeVisible();
    await expect(page.locator(".tier-group h3")).toHaveCount(0);
    // pid 4 has R-silent (junior): no tier chip on the drawer either.
    await page.goto("/papers/4");
    await expect(page.locator(".who").first()).toBeVisible();
    await expect(page.locator(".who .tier")).toHaveCount(0);
  });

  test("with tiers (the E2E default) they are all there", async ({ page }) => {
    await page.unroute("**/api/meta");
    await page.goto("/");
    await expect(page.getByTestId("filter-tier")).toBeVisible();
    await expect(page.getByTestId("nav-modules").getByRole("link", { name: "Reviewing by tier" })).toBeVisible();
    await page.goto(`/people/${encodeURIComponent(P.silent)}`);
    await expect(page.getByTestId("person-tier")).toHaveText(/junior/i);
    await page.goto("/papers/4");
    await expect(page.locator(".who .tier").first()).toBeVisible();
  });
});
