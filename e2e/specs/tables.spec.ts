// Column sort and filter (spec §4 "Tables") on the triage and AC tables over
// golden: header sort (asc → desc → off, shift-click for a secondary key,
// aria-sort), a categorical filter with counts, a numeric range, a text
// filter with suggestions, chips with "N of M" and clear, keyboard use, and
// the state living in the URL (reload, navigation, composing with ?search=).
import { expect, test, type Locator, type Page } from "@playwright/test";
import type { MetaResponse } from "@pcs/server/server/api-types";
import { P } from "@pcs/seed/scenarios/golden/scenario";
import { expectedTriage, FIRES_AT_PRIMARY } from "../support/golden.js";

let meta: MetaResponse;
test.beforeAll(async ({ request }) => {
  meta = (await (await request.get("/api/meta")).json()) as MetaResponse;
});

const N = Object.keys(FIRES_AT_PRIMARY).length;
const triage = (page: Page) => page.getByTestId("triage-table");
const sortBtn = (table: Locator, col: string) => table.locator(`[data-testid="dt-sort"][data-col="${col}"]`);
const header = (table: Locator, col: string) => table.locator(`[role="columnheader"][data-col="${col}"]`);
const filterBtn = (table: Locator, col: string) => table.locator(`[data-testid="dt-filter"][data-col="${col}"]`);
const popover = (page: Page) => page.getByTestId("dt-filter-popover");
const option = (page: Page, value: string) => popover(page).locator(`[data-testid="fp-option"][data-value="${value}"]`);
const rowPids = (page: Page) => page.getByTestId("triage-row").evaluateAll((els) => els.map((e) => Number(e.getAttribute("data-pid"))));
const severities = (page: Page) =>
  page.getByTestId("triage-row").evaluateAll((els) => els.map((e) => Number(e.querySelector('[data-testid="severity"]')!.textContent)));
const query = (page: Page) => new URL(page.url()).searchParams;

test.describe("triage table", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("triage-row")).toHaveCount(N);
  });

  test("a header click sorts ascending, then descending, then back to the server's order", async ({ page }) => {
    const want = expectedTriage(meta);
    const t = triage(page);
    await expect(header(t, "severity")).toHaveAttribute("aria-sort", "none");
    await sortBtn(t, "severity").click();
    await expect(header(t, "severity")).toHaveAttribute("aria-sort", "ascending");
    expect(query(page).get("tri.sort")).toBe("severity");
    // Ascending and stable: ties keep the server's order (pid within a severity).
    const asc = [...want].sort((a, b) => a.severity - b.severity);
    await expect.poll(() => rowPids(page)).toEqual(asc.map((r) => r.pid));
    await sortBtn(t, "severity").click();
    await expect(header(t, "severity")).toHaveAttribute("aria-sort", "descending");
    await expect.poll(() => severities(page)).toEqual(want.map((r) => r.severity));
    await sortBtn(t, "severity").click();
    await expect(header(t, "severity")).toHaveAttribute("aria-sort", "none");
    await expect.poll(() => rowPids(page)).toEqual(want.map((r) => r.pid));
    expect(query(page).has("tri.sort")).toBe(false);
  });

  test("shift-click adds a secondary sort, shown with its rank", async ({ page }) => {
    const t = triage(page);
    await sortBtn(t, "severity").click();
    await sortBtn(t, "pid").click({ modifiers: ["Shift"] });
    await sortBtn(t, "pid").click({ modifiers: ["Shift"] });
    expect(query(page).get("tri.sort")).toBe("severity,-pid");
    await expect(sortBtn(t, "pid").getByTestId("dt-sort-ind")).toHaveText("▼2");
    const want = expectedTriage(meta)
      .sort((a, b) => a.severity - b.severity || b.pid - a.pid)
      .map((r) => r.pid);
    await expect.poll(() => rowPids(page)).toEqual(want);
  });

  test("the AC filter: a searchable multi-select with counts, chips, N of M, and clear", async ({ page }) => {
    const t = triage(page);
    await filterBtn(t, "acs").click();
    await expect(popover(page)).toBeVisible();
    await expect(popover(page).getByTestId("fp-search")).toBeFocused();
    await expect(option(page, "Indra Idleworth").getByTestId("fp-count")).toHaveText("2");
    await expect(option(page, "Indra Idleworth")).toHaveAttribute("aria-selected", "true");
    await popover(page).getByTestId("fp-none").click();
    await expect(page.getByTestId("triage-row")).toHaveCount(0);
    await option(page, "Indra Idleworth").click();
    await expect.poll(() => rowPids(page)).toEqual([5, 7]);
    await popover(page).getByTestId("fp-done").click();
    await expect(popover(page)).toBeHidden();
    await expect(filterBtn(t, "acs")).toBeFocused();
    await expect(filterBtn(t, "acs")).toHaveAttribute("aria-label", /\(filtered\)/);

    const chip = t.locator('[data-testid="dt-chip"][data-col="acs"]');
    await expect(chip).toHaveText(/AC: Indra Idleworth/);
    await expect(t.getByTestId("dt-count")).toHaveText(`2 of ${N} papers`);
    await expect(page.getByTestId("triage-count")).toHaveText(`2 of ${N} papers`);
    expect(query(page).getAll("tri.acs")).toEqual(["Indra Idleworth"]);
    // The actions bar works on what the table shows.
    await expect(page.getByTestId("hotcrp-search")).toHaveText("5 7");

    await chip.getByTestId("dt-chip-remove").click();
    await expect(page.getByTestId("triage-row")).toHaveCount(N);
    await expect(t.getByTestId("dt-chips")).toHaveCount(0);
  });

  test("a numeric range on severity, by inputs or by a histogram bar", async ({ page }) => {
    const t = triage(page);
    const want = expectedTriage(meta);
    await filterBtn(t, "severity").click();
    await expect(popover(page).getByTestId("fp-hist")).toBeVisible();
    // A bar is one severity value (small integers): clicking it filters to exactly that value.
    await popover(page).getByRole("button", { name: /^5: \d+ rows$/ }).click();
    await expect.poll(() => rowPids(page)).toEqual(want.filter((r) => r.severity === 5).map((r) => r.pid));
    await expect(popover(page).getByTestId("fp-max")).toHaveValue("5");
    await popover(page).getByTestId("fp-min").fill("3");
    await expect.poll(() => rowPids(page)).toEqual(want.filter((r) => r.severity >= 3 && r.severity <= 5).map((r) => r.pid));
    await popover(page).getByTestId("fp-max").fill("4");
    await expect.poll(() => rowPids(page)).toEqual(want.filter((r) => r.severity >= 3 && r.severity <= 4).map((r) => r.pid));
    expect(query(page).get("tri.severity")).toBe("3..4");
    await expect(t.locator('[data-testid="dt-chip"][data-col="severity"]')).toHaveText(/Severity 3–4/);
    // Esc closes and returns focus to the filter button; the filter stays.
    await page.keyboard.press("Escape");
    await expect(popover(page)).toBeHidden();
    await expect(filterBtn(t, "severity")).toBeFocused();

    // A second filter composes (AND); "Clear all" drops both.
    await filterBtn(t, "title").click();
    await popover(page).getByTestId("fp-text").fill("zzz-no-such-title");
    await expect(page.getByTestId("triage-row")).toHaveCount(0);
    await expect(t.getByText("No rows match the column filters.")).toBeVisible();
    await page.keyboard.press("Escape");
    await t.getByTestId("dt-clear-all").click();
    await expect(page.getByTestId("triage-row")).toHaveCount(N);
    expect([...query(page).keys()].filter((k) => k.startsWith("tri."))).toEqual([]);
  });

  test("keyboard: open a filter, search, select with Enter, close with Esc", async ({ page }) => {
    const t = triage(page);
    await filterBtn(t, "acs").focus();
    await page.keyboard.press("Enter");
    await expect(popover(page).getByTestId("fp-search")).toBeFocused();
    await page.getByTestId("fp-none").click();
    await popover(page).getByTestId("fp-search").fill("idle");
    await expect(popover(page).getByTestId("fp-option")).toHaveCount(1);
    await page.keyboard.press("Enter");
    await expect.poll(() => rowPids(page)).toEqual([5, 7]);
    await page.keyboard.press("Escape");
    await expect(filterBtn(t, "acs")).toBeFocused();
  });

  test("sort and filters live in the URL: reload, shared link, navigation, the drawer, and ?search=", async ({ page }) => {
    await page.goto("/?search=1-8&tri.sort=-pid&tri.severity=3..");
    const want = expectedTriage(meta)
      .filter((r) => r.pid <= 8 && r.severity >= 3)
      .map((r) => r.pid)
      .sort((a, b) => b - a);
    await expect.poll(() => rowPids(page)).toEqual(want);
    await expect(header(triage(page), "pid")).toHaveAttribute("aria-sort", "descending");
    await page.reload();
    await expect.poll(() => rowPids(page)).toEqual(want);
    // The drawer and back keep it.
    await page.locator(`[data-testid="triage-row"][data-pid="${want[0]}"]`).click();
    await expect(page.getByTestId("paper-drawer")).toBeVisible();
    expect(query(page).get("tri.sort")).toBe("-pid");
    await page.getByTestId("drawer-close").click();
    await expect.poll(() => rowPids(page)).toEqual(want);
    // Another view and back through the nav keeps it, with ?search=.
    await page.getByTestId("nav").getByRole("link", { name: "ACs" }).click();
    await expect(page).toHaveURL(/\/acs\?/);
    await page.getByTestId("nav").getByRole("link", { name: "Triage" }).click();
    await expect.poll(() => rowPids(page)).toEqual(want);
    expect(query(page).get("search")).toBe("1-8");
    expect(query(page).get("tri.severity")).toBe("3..");
  });
});

test.describe("AC table", () => {
  const acRows = (page: Page) => page.getByTestId("ac-row").evaluateAll((els) => els.map((e) => e.getAttribute("data-email")));
  const acs = (page: Page) => page.getByTestId("ac-table");

  test.beforeEach(async ({ page }) => {
    await page.goto("/acs");
    await expect(page.getByTestId("ac-row")).toHaveCount(3);
  });

  test("defaults to alphabetical, sorts by load when the chair asks, and back", async ({ page }) => {
    const alpha = [P.acBusy, P.acIdle, P.acNormal];
    await expect.poll(() => acRows(page)).toEqual(alpha);
    await sortBtn(acs(page), "load").click();
    await expect.poll(() => acRows(page)).toEqual([P.acIdle, P.acNormal, P.acBusy]);
    await sortBtn(acs(page), "load").click();
    await expect(header(acs(page), "load")).toHaveAttribute("aria-sort", "descending");
    await expect.poll(() => acRows(page)).toEqual([P.acBusy, P.acNormal, P.acIdle]);
    await sortBtn(acs(page), "load").click();
    await expect.poll(() => acRows(page)).toEqual(alpha);
  });

  test("a numeric range on load and a text filter on the name, persisted across reload", async ({ page }) => {
    await filterBtn(acs(page), "load").click();
    await popover(page).getByTestId("fp-min").fill("5");
    await expect.poll(() => acRows(page)).toEqual([P.acBusy, P.acNormal]);
    await page.keyboard.press("Escape");
    await expect(acs(page).getByTestId("dt-count")).toHaveText("2 of 3 ACs");

    await filterBtn(acs(page), "name").click();
    const box = popover(page).getByTestId("fp-text");
    await box.fill("norm");
    await expect(popover(page).getByTestId("fp-suggestion")).toHaveText(["Noor Normandy1"]);
    await page.keyboard.press("Enter");
    await expect(box).toHaveValue("Noor Normandy");
    await expect.poll(() => acRows(page)).toEqual([P.acNormal]);
    await page.keyboard.press("Escape");

    await page.reload();
    await expect.poll(() => acRows(page)).toEqual([P.acNormal]);
    await expect(acs(page).getByTestId("dt-chip")).toHaveText([/^Area chair contains “Noor Normandy”/, /^Load ≥ 5/]);
    await acs(page).locator('[data-testid="dt-chip"][data-col="name"]').getByTestId("dt-chip-remove").click();
    await expect.poll(() => acRows(page)).toEqual([P.acBusy, P.acNormal]);
    expect(query(page).get("ac.load")).toBe("5..");
    expect(query(page).has("ac.name")).toBe(false);
  });
});
