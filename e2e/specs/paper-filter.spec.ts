// The in-app paper filter (?search=, a HotCRP search resolved by the server)
// against golden: it narrows triage, the AC table and the overview, sticks
// to the URL across navigation and reloads, and shows clean errors.
// Golden: AC-idle (Indra Idleworth) chairs exactly papers 5 and 7.
import { expect, test, type Page } from "@playwright/test";
import { P } from "@pcs/seed/scenarios/golden/scenario";
import { FIRES_AT_PRIMARY } from "../support/golden.js";

const ALL = Object.keys(FIRES_AT_PRIMARY).length;
const rows = (page: Page) => page.getByTestId("triage-row");
const rowPids = async (page: Page) => (await rows(page).evaluateAll((els) => els.map((e) => Number(e.getAttribute("data-pid"))))).sort((a, b) => a - b);
const acRow = (page: Page, email: string) => page.locator(`[data-testid="ac-row"][data-email="${email}"]`);
const input = (page: Page) => page.getByTestId("paper-filter-input");

async function filter(page: Page, search: string) {
  await input(page).fill(search);
  await input(page).press("Enter");
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(rows(page)).toHaveCount(ALL);
});

test("a HotCRP search narrows triage and follows the chair to the AC table and overview", async ({ page }) => {
  await filter(page, "5 7");
  await expect.poll(() => rowPids(page)).toEqual([5, 7]);
  await expect(page).toHaveURL(/\/\?search=5\+7$/);
  await expect(page.getByTestId("paper-filter-status")).toHaveText("2 papers match");
  await expect(page.getByTestId("triage-count")).toHaveText("2 of 2 papers");

  // The nav keeps the filter; AC rows count only the matching papers.
  await page.getByTestId("nav").getByRole("link", { name: "ACs" }).click();
  await expect(page).toHaveURL(/\/acs\?search=5\+7$/);
  await expect(input(page)).toHaveValue("5 7");
  await expect(acRow(page, P.acIdle).getByTestId("ac-load")).toHaveText("2 papers · 2 flagged");
  for (const load of await page.getByTestId("ac-load").evaluateAll((els) => els.map((e) => Number(e.getAttribute("data-load"))))) {
    expect(load).toBeLessThanOrEqual(2);
  }
  // Clicking an AC row opens triage for that AC, still filtered.
  await acRow(page, P.acIdle).click();
  await expect(page).toHaveURL(/ac=ac-idle%40example\.org/);
  await expect(page).toHaveURL(/search=5\+7/);
  await expect.poll(() => rowPids(page)).toEqual([5, 7]);

  await page.getByTestId("nav").getByRole("link", { name: "Overview" }).click();
  await expect(page.getByTestId("count-papers")).toContainText("2");

  // A reload or a shared link gives the same view.
  await page.goto("/acs?search=5%207");
  await expect(acRow(page, P.acIdle).getByTestId("ac-load")).toHaveText("2 papers · 2 flagged");
});

test("clearing the filter brings every paper back", async ({ page }) => {
  await filter(page, "5");
  await expect.poll(() => rowPids(page)).toEqual([5]);
  await expect(page.getByTestId("paper-filter-status")).toHaveText("1 paper matches");
  await page.getByTestId("paper-filter-clear").click();
  await expect(rows(page)).toHaveCount(ALL);
  await expect(page).toHaveURL(/\/$/);
  await expect(input(page)).toHaveValue("");
});

test("a search that can't run shows a clean error, not the token or a URL", async ({ page }) => {
  await filter(page, "(5");
  await expect(page.getByTestId("paper-filter-error")).toHaveText("That search has a ( without a matching ).");
  await expect(page.getByText(/Could not load the triage list/)).toBeVisible();

  await filter(page, "nosuchkeyword:x");
  await expect(page.getByTestId("paper-filter-error")).toContainText("HotCRP could not use that search");
  const text = await page.locator("body").innerText();
  expect(text).not.toContain("hct_");
  expect(text).not.toContain(process.env.PCS_HOTCRP_URL ?? "unset");
});

test("pages that don't filter by paper don't show the box", async ({ page }) => {
  await page.goto("/modules/reserve");
  await expect(page.getByTestId("paper-filter")).toHaveCount(0);
});
