// The in-app paper filter (?search=, a HotCRP search resolved by the server)
// against golden: it narrows triage, the AC table and the overview, sticks
// to the URL across navigation and reloads, shows HotCRP's warnings and clean
// errors, autocompletes from the keyboard, and searches in HotCRP's "Search
// in" collections (?t=). Tag completion (#…) needs tags, which golden papers
// don't have: tagging.spec.ts covers it once #chair-attention is set.
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

test("searches HotCRP accepts work as in HotCRP: unbalanced parentheses, warnings shown beside the count", async ({ page }) => {
  // HotCRP closes an unclosed ( itself; the filter no longer refuses it.
  await filter(page, "(5");
  await expect.poll(() => rowPids(page)).toEqual([5]);
  await expect(page.getByTestId("paper-filter-status")).toHaveText("1 paper matches");

  // An unknown keyword: HotCRP warns and matches nothing; so does the filter.
  await filter(page, "nosuchkeyword:x");
  await expect(page.getByTestId("paper-filter-warning")).toContainText("HotCRP: Unknown search keyword");
  await expect(page.getByTestId("paper-filter-status")).toHaveText("0 papers match");
  await expect(rows(page)).toHaveCount(0);
  const text = await page.locator("body").innerText();
  expect(text).not.toContain("hct_");
  expect(text).not.toContain(process.env.PCS_HOTCRP_URL ?? "unset");
});

test("a collection HotCRP doesn't have is a clean error", async ({ page }) => {
  await page.goto("/?search=5&t=nosuch");
  await expect(page.getByTestId("paper-filter-error")).toContainText('"Search in" must be one of HotCRP\'s collections');
  await expect(page.getByText(/Could not load the triage list/)).toBeVisible();
});

test("autocomplete: keyboard-first, mid-query, accessible", async ({ page }) => {
  const box = input(page);
  const list = page.getByTestId("paper-filter-suggestions");
  const items = page.getByTestId("paper-filter-suggestion");
  await box.click();
  await box.pressSequentially("5 OR le");
  await expect(list).toBeVisible();
  await expect(box).toHaveAttribute("role", "combobox");
  await expect(box).toHaveAttribute("aria-expanded", "true");
  await expect(list).toHaveAttribute("role", "listbox");
  await expect(items.first()).toHaveAttribute("data-insert", "lead:");
  await expect(items.first()).toHaveAttribute("aria-selected", "true");
  await expect(box).toHaveAttribute("aria-activedescendant", (await items.first().getAttribute("id"))!);

  // Tab accepts a keyword and keeps completing its values.
  await box.press("Tab");
  await expect(box).toHaveValue("5 OR lead:");
  await expect(items.first()).toHaveAttribute("data-insert", "lead:any");
  // ↓ moves, ↑ moves back, Esc closes without changing the text.
  await box.press("ArrowDown");
  await expect(items.nth(1)).toHaveAttribute("aria-selected", "true");
  await box.press("ArrowUp");
  await expect(items.first()).toHaveAttribute("aria-selected", "true");
  await box.press("Escape");
  await expect(list).toBeHidden();
  await expect(box).toHaveAttribute("aria-expanded", "false");
  await expect(box).toHaveValue("5 OR lead:");
  // ↓ reopens; PC members complete by name, and Enter accepts.
  await box.pressSequentially("idle");
  await expect(items.first()).toHaveAttribute("data-insert", `lead:${P.acIdle}`);
  await box.press("Enter");
  await expect(box).toHaveValue(`5 OR lead:${P.acIdle} `);
  await expect(list).toBeHidden();
  // With the list closed, Enter applies the filter.
  await box.press("Enter");
  await expect(page).toHaveURL(/search=5\+OR\+lead%3Aac-idle%40example\.org/);
  await expect(page.getByTestId("paper-filter-status")).toBeVisible();

  // Mid-query, inside parentheses, after NOT: the token under the caret.
  await box.fill("(7 OR dec:ye) -#x");
  await box.evaluate((el: HTMLInputElement) => el.setSelectionRange(12, 12));
  await box.press("ArrowDown");
  await expect(items.first()).toHaveAttribute("data-insert", "dec:yes");
  await box.press("Enter");
  await expect(box).toHaveValue("(7 OR dec:yes) -#x");

  // A score field from the review form, with comparisons.
  await box.fill("");
  await box.pressSequentially("OveMer:>=");
  await expect(items.first()).toHaveAttribute("data-insert", /^OveMer:>=\d$/);
});

test("Search in: HotCRP's collections, in the URL with the search", async ({ page }) => {
  const sel = page.getByTestId("paper-filter-collection");
  await expect(sel.locator("option").first()).toHaveText(/\(HotCRP default\)$/);
  await sel.selectOption("all");
  await expect(page).toHaveURL(/\?t=all$/);
  await expect(page.getByTestId("paper-filter-status")).toHaveText(`${ALL} papers match`);
  await filter(page, "5 7");
  await expect(page).toHaveURL(/search=5\+7/);
  await expect(page).toHaveURL(/t=all/);
  await expect.poll(() => rowPids(page)).toEqual([5, 7]);
  // It follows the chair like the search, and survives a reload.
  await page.getByTestId("nav").getByRole("link", { name: "ACs" }).click();
  await expect(page).toHaveURL(/\/acs\?.*t=all/);
  await page.reload();
  await expect(page.getByTestId("paper-filter-collection")).toHaveValue("all");
  // Accepted: golden's one decision so far (paper 1).
  await page.goto("/?t=accepted");
  await expect(page.getByTestId("paper-filter-status")).toHaveText("1 paper matches");
  await expect.poll(() => rowPids(page)).toEqual([1]);
  await page.getByTestId("paper-filter-clear").click();
  await expect(page).toHaveURL(/\/$/);
  await expect(rows(page)).toHaveCount(ALL);
});

test("pages that don't filter by paper don't show the box", async ({ page }) => {
  await page.goto("/modules/reserve");
  await expect(page.getByTestId("paper-filter")).toHaveCount(0);
});
