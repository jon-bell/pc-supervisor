// PLAN M5 against golden: triage order, reason chips, filters, deep links.
import { argosScreenshot } from "@argos-ci/playwright";
import { expect, test, type Page } from "@playwright/test";
import type { MetaResponse } from "@pcs/server/server/api-types";
import { expectedTriage, FIRES_AT_PRIMARY } from "../support/golden.js";

const HOTCRP = (process.env.PCS_HOTCRP_URL ?? "").replace(/\/+$/, "");
let meta: MetaResponse;

test.beforeAll(async ({ request }) => {
  meta = (await (await request.get("/api/meta")).json()) as MetaResponse;
});

const rows = (page: Page) => page.getByTestId("triage-row");
const row = (page: Page, pid: number) => page.locator(`[data-testid="triage-row"][data-pid="${pid}"]`);
const rowPids = async (page: Page) => (await rows(page).evaluateAll((els) => els.map((e) => Number(e.getAttribute("data-pid")))));

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(rows(page)).toHaveCount(Object.keys(FIRES_AT_PRIMARY).length);
});

test("the triage list is ordered by severity computed from the golden table, ties by pid", async ({ page }) => {
  const want = expectedTriage(meta);
  // The top rows exactly, with their severities: 5 (7), 4 (5), 13 (4: REVIEW_FLAGGED), then the 3s by pid.
  expect(want.slice(0, 6).map((r) => [r.pid, r.severity])).toEqual([
    [5, 7],
    [4, 5],
    [13, 4],
    [2, 3],
    [3, 3],
    [12, 3],
  ]);
  expect(await rowPids(page)).toEqual(want.map((r) => r.pid));
  for (const r of want) {
    await expect(row(page, r.pid).getByTestId("severity")).toHaveText(String(r.severity));
  }
});

test("each row shows exactly its golden reason chips, with the reason on hover; paper 1 shows none", async ({ page }) => {
  await expect(row(page, 1).getByTestId("chip")).toHaveCount(0);
  for (const [pid, rules] of Object.entries(FIRES_AT_PRIMARY)) {
    const chips = row(page, Number(pid)).getByTestId("chip");
    const got = await chips.evaluateAll((els) => els.map((e) => e.getAttribute("data-rule")));
    expect(got.sort(), `pid ${pid}`).toEqual([...rules].sort());
  }
  // The reason string, with numbers, is the chip's title.
  const unresolved = row(page, 4).locator('[data-rule="UNRESOLVED_SPLIT"]');
  await expect(unresolved).toHaveAttribute("title", /^scores 2\/4\/4; no movement since discussion opened 14\.5 days ago/);
  await expect(row(page, 1).getByTestId("scores")).toHaveText("3/3/4");
  // Rating-based reasons quote the counts.
  const flagged = row(page, 13).locator('[data-rule="REVIEW_FLAGGED"]');
  await expect(flagged).toHaveText("Flagged review");
  await expect(flagged).toHaveAttribute("title", "1 review rated disrespectful or wrong: review B: 1× short, 1× disrespectful");
  await expect(row(page, 10).locator('[data-rule="THIN_REVIEWS"]')).toHaveAttribute("title", /review B: 35 words, 2× short$/);
  await expect(row(page, 2).getByTestId("scores")).toContainText("(2/3)");
});

test("deep links point at PCS_HOTCRP_URL", async ({ page }) => {
  expect(HOTCRP).toMatch(/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/);
  expect(meta.hotcrpUrl).toBe(HOTCRP);
  for (const pid of await rowPids(page)) {
    await expect(row(page, pid).getByTestId("hotcrp-link")).toHaveAttribute("href", `${HOTCRP}/paper/${pid}`);
  }
});

test("filters by AC, rule and tier", async ({ page }) => {
  await page.getByTestId("filter-ac").selectOption({ label: "Indra Idleworth (2)" });
  await expect.poll(() => rowPids(page)).toEqual([5, 7]);
  await expect(page).toHaveURL(/\?ac=ac-idle%40example\.org$/);
  await page.getByTestId("filter-ac").selectOption("");
  await page.getByTestId("filter-rule").selectOption("SPLIT");
  await expect.poll(() => rowPids(page)).toEqual([4, 3, 12]);
  await page.getByTestId("filter-tier").selectOption("junior");
  await expect.poll(() => rowPids(page)).toEqual([4, 3, 12]);
  await page.getByTestId("filter-rule").selectOption("");
  await page.getByTestId("filter-tier").selectOption("reciprocal");
  await expect.poll(() => rowPids(page)).toEqual([2]);
  await expect(page.getByTestId("triage-count")).toHaveText("1 of 13 papers");
  // Filters live in the URL, so a filtered view deep-links.
  await page.goto("/?rule=AC_ABSENT");
  await expect.poll(() => rowPids(page)).toEqual([5, 7]);
});

test("wording follows spec §7", async ({ page }) => {
  await expect(row(page, 5).locator('[data-rule="SILENT_DISCUSSION"]')).toHaveText("No comments yet");
  const text = (await page.locator("body").innerText()).toLowerCase();
  for (const word of ["disengaged", "absent", "lazy"]) expect(text).not.toContain(word);
});

test("screenshot: triage list", async ({ page }) => {
  await expect(page.getByTestId("sync-status")).toHaveAttribute("data-running", "false");
  await argosScreenshot(page, "triage-list");
});
