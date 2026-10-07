// PLAN M8 against golden, read-only: copyable HotCRP searches (triage list,
// AC and reviewer-tier filters, person page) and nudge-comment drafts, both
// checked through the real clipboard. A copied search must mean the same
// set in HotCRP itself.
import { argosScreenshot } from "@argos-ci/playwright";
import { expect, test, type Page } from "@playwright/test";
import { E2E_PORT } from "../support/env.js";
import { harnessClient, searchPids } from "../support/hotcrp.js";

const HOTCRP = (process.env.PCS_HOTCRP_URL ?? "").replace(/\/+$/, "");
const hotcrp = harnessClient();

test.beforeEach(async ({ context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: `http://127.0.0.1:${E2E_PORT}` });
});

const clipboard = (page: Page) => page.evaluate(() => navigator.clipboard.readText());
const rowPids = (page: Page) => page.getByTestId("triage-row").evaluateAll((els) => els.map((e) => Number(e.getAttribute("data-pid"))));

async function expectSearch(page: Page, q: string, pids: number[]) {
  await expect(page.getByTestId("hotcrp-search")).toHaveText(q);
  await page.getByTestId("copy-search").click();
  await expect(page.getByTestId("copy-search")).toHaveAttribute("data-state", "copied");
  expect(await clipboard(page)).toBe(q);
  await expect(page.getByTestId("hotcrp-search-link")).toHaveAttribute("href", `${HOTCRP}/search?${new URLSearchParams({ q, t: "all" })}`);
  // HotCRP reads the copied search as exactly this set.
  expect(await searchPids(hotcrp, q)).toEqual(pids);
}

test("copy search: the whole list, an AC filter, a reviewer-tier filter, a rule filter", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("triage-row")).toHaveCount(12);
  await expectSearch(page, "1-12", [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

  await page.getByTestId("filter-ac").selectOption({ label: "Avery Busyfield (6)" });
  await expect.poll(async () => (await rowPids(page)).sort((a, b) => a - b)).toEqual([1, 3, 4, 8, 9, 10]);
  await expectSearch(page, "1 3 4 8-10", [1, 3, 4, 8, 9, 10]);

  await page.goto("/?tier=junior");
  await expect.poll(async () => (await rowPids(page)).sort((a, b) => a - b)).toEqual([3, 4, 12]);
  await expectSearch(page, "3 4 12", [3, 4, 12]);

  await page.goto("/?rule=AC_ABSENT");
  await expect.poll(() => rowPids(page)).toEqual([5, 7]);
  await expectSearch(page, "5 7", [5, 7]);
});

test("copy search on a person page lists their papers", async ({ page }) => {
  await page.goto(`/people/${encodeURIComponent("r-silent@example.org")}`);
  await expect(page.getByTestId("person-paper")).toHaveCount(3);
  await expectSearch(page, "3 4 12", [3, 4, 12]);
});

test("nudge draft on split paper 4 @mentions the reviewers with no comments yet, with the reasons", async ({ page }) => {
  await page.goto("/papers/4");
  const drawer = page.getByTestId("paper-drawer");
  await drawer.getByTestId("nudge-draft").click();
  const text = drawer.getByTestId("nudge-text");
  await expect(text).toHaveValue(/^@Sam Silvermoon @Pat Pingleton\n/);
  const value = await text.inputValue();
  expect(value).toContain("- Scores are split: merit 2/4/4 (range 2 >= 2; scores on both sides of 3)");
  expect(value).toMatch(/- No score movement yet: scores 2\/4\/4; no movement since discussion opened 14\.5 days ago/);
  expect(value).toContain("could you add a comment with your current view?");
  expect(value).not.toMatch(/disengaged|absent/i);
  await drawer.getByTestId("copy-nudge").click();
  await expect(drawer.getByTestId("copy-nudge")).toHaveAttribute("data-state", "copied");
  expect(await clipboard(page)).toBe(value);
  // Wait for the "Copied" label to reset, so the screenshot is stable.
  await expect(drawer.getByTestId("copy-nudge")).toHaveAttribute("data-state", "idle", { timeout: 5000 });
  await argosScreenshot(page, "paper-4-nudge-draft");
});

test("nudge draft on paper 2 asks the reviewer whose review isn't submitted", async ({ page }) => {
  await page.goto("/papers/2");
  const drawer = page.getByTestId("paper-drawer");
  await drawer.getByTestId("nudge-draft").click();
  await expect(drawer.getByTestId("nudge-text")).toHaveValue(/^@Remy Reciprocca\n[\s\S]*Could you submit your review when you can/);
});
