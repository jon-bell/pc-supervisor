// PLAN M6 against golden: the people-level facts on the AC table, the
// reviewer outlier lists, the person page and the overview, plus Argos
// baselines for the AC table, R-silent's person page and the overview.
import { argosScreenshot } from "@argos-ci/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { P } from "@pcs/seed/scenarios/golden/scenario";
import { PEOPLE } from "@pcs/seed/scenarios/golden/expected";

const acRow = (page: Page, email: string) => page.locator(`[data-testid="ac-row"][data-email="${email}"]`);
const triagePids = async (page: Page) =>
  (await page.getByTestId("triage-row").evaluateAll((els) => els.map((e) => Number(e.getAttribute("data-pid"))))).sort((a, b) => a - b);
const group = (page: Page, list: string, tier: string) => page.locator(`[data-testid="tier-group"][data-list="${list}"][data-tier="${tier}"]`);
const outlier = (g: Locator, email: string) => g.locator(`[data-testid="outlier-row"][data-email="${email}"]`);
const days = async (l: Locator) => Number((await l.innerText()).match(/(\d+(?:\.\d)?) days/)![1]);
const ready = async (page: Page) => expect(page.getByTestId("sync-status")).toHaveAttribute("data-running", "false");

test.describe("AC table", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/acs");
    await expect(page.getByTestId("ac-row")).toHaveCount(3);
  });

  test("the load column tells AC-busy from AC-idle at a glance", async ({ page }) => {
    const busy = acRow(page, P.acBusy);
    const idle = acRow(page, P.acIdle);
    expect(PEOPLE.acs[P.acBusy].pids).toHaveLength(6);
    expect(PEOPLE.acs[P.acBusy].flagged).toHaveLength(5);
    await expect(busy.getByTestId("ac-load")).toHaveText("6 papers · 5 flagged");
    await expect(idle.getByTestId("ac-load")).toHaveText("2 papers · 2 flagged");
    await expect(acRow(page, P.acNormal).getByTestId("ac-load")).toHaveText("5 papers · 5 flagged");
    // The load bar: AC-busy's is three times AC-idle's, and AC-idle's is all flagged.
    const width = (row: Locator, cls: string) => row.locator(`.loadbar .${cls}`).evaluate((e) => Number(e.getAttribute("width")));
    expect(await width(busy, "load-total")).toBeCloseTo(3 * (await width(idle, "load-total")), 5);
    expect(await width(idle, "load-flagged")).toBeCloseTo(await width(idle, "load-total"), 5);
    expect(await width(busy, "load-flagged")).toBeLessThan(await width(busy, "load-total"));
    // AC-idle: no comments at all; AC-busy commented on every paper.
    await expect(idle.getByTestId("ac-comments")).toHaveText("0");
    await expect(idle.getByTestId("ac-coverage")).toHaveText("0/2 · 0%");
    await expect(idle.getByTestId("ac-spark")).toHaveAttribute("data-total", "0");
    await expect(busy.getByTestId("ac-coverage")).toHaveText("6/6 · 100%");
    // Nudges are labelled as a proxy.
    await expect(page.getByRole("columnheader", { name: "Nudges (proxy)" })).toBeVisible();
    await expect(busy.getByTestId("ac-nudges")).toHaveAttribute("title", /^A proxy, not a count of nudges/);
  });

  test("clicking an AC row filters triage to that AC's papers", async ({ page }) => {
    await acRow(page, P.acNormal).click();
    await expect(page).toHaveURL(/\/\?ac=ac-normal%40example\.org$/);
    await expect.poll(() => triagePids(page)).toEqual([...PEOPLE.acs[P.acNormal].pids]);
    await expect(page.getByTestId("filter-ac")).toHaveValue(P.acNormal);
    await page.goto("/acs");
    await acRow(page, P.acBusy).click();
    await expect.poll(() => triagePids(page)).toEqual([...PEOPLE.acs[P.acBusy].pids]);
    await page.goto("/acs");
    await acRow(page, P.acIdle).click();
    await expect.poll(() => triagePids(page)).toEqual([5, 7]);
  });

  test("screenshot: AC table", async ({ page }) => {
    await ready(page);
    await argosScreenshot(page, "ac-table");
  });
});

test.describe("reviewer outliers", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/reviewers");
    await expect(page.getByTestId("outlier-list")).toHaveCount(5);
  });

  test("Hal is the one repeatedly flagged reviewer, with the flag counts", async ({ page }) => {
    const rows = page.locator('[data-testid="tier-group"][data-list="flagged"] [data-testid="outlier-row"]');
    await expect(rows).toHaveCount(1);
    const hal = outlier(group(page, "flagged", "senior"), PEOPLE.repeatedlyFlagged.email);
    await expect(hal.getByTestId("outlier-count")).toHaveText("2");
    await expect(hal.getByTestId("outlier-pids")).toHaveText("#10 #13");
    await expect(hal.getByTestId("outlier-detail")).toHaveText("negative rating flags on 2 papers: 3× short, 1× disrespectful");
  });

  test("R-silent is on silent-on-split with 3, under junior", async ({ page }) => {
    const junior = group(page, "silentOnSplit", "junior");
    const silent = outlier(junior, P.silent);
    await expect(silent.getByTestId("outlier-count")).toHaveText("3");
    await expect(silent.getByTestId("outlier-pids")).toHaveText("#3 #4 #12");
    // Nobody in any tier is further over the bar.
    const counts = await page
      .locator('[data-testid="tier-group"][data-list="silentOnSplit"] [data-testid="outlier-count"]')
      .evaluateAll((els) => els.map((e) => Number(e.textContent)));
    expect(Math.max(...counts)).toBe(3);
    expect(counts.filter((c) => c === 3)).toHaveLength(1);
    // R-pinged (senior) is there too, with pid 4.
    await expect(outlier(group(page, "silentOnSplit", "senior"), P.pinged).getByTestId("outlier-pids")).toHaveText("#4");
    // Outlier lists, not a leaderboard: no rank numbers, and sorted by name by default.
    await expect(page.locator("body")).not.toContainText(/#1 reviewer|leaderboard|worst/i);
    await expect(page.getByTestId("sort-name")).toHaveClass(/btn-on/);
    const byName = async () => group(page, "silentOnSplit", "senior").getByTestId("outlier-name").allInnerTexts();
    const names = await byName();
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    // Count order is opt-in (?sort=count), and back.
    await page.getByTestId("sort-count").click();
    await expect(page).toHaveURL(/\?sort=count$/);
    const juniorCounts = await junior.getByTestId("outlier-count").evaluateAll((els) => els.map((e) => Number(e.textContent)));
    expect(juniorCounts).toEqual([...juniorCounts].sort((a, b) => b - a));
    await page.getByTestId("sort-name").click();
    await expect(page).not.toHaveURL(/sort=/);
    expect(await byName()).toEqual(names);
  });

  test("R-pinged has an unanswered ping of 11+ days on pid 4", async ({ page }) => {
    const row = outlier(group(page, "unansweredPings", "senior"), P.pinged);
    await expect(row.getByTestId("outlier-pids")).toHaveText("#4");
    expect(await days(row.getByTestId("outlier-detail"))).toBeGreaterThanOrEqual(11);
  });

  test("the pid 2 laggard shows as reciprocal and late", async ({ page }) => {
    const row = outlier(group(page, "late", "reciprocal"), P.recip);
    await expect(row).toBeVisible();
    await expect(row.getByTestId("outlier-pids")).toHaveText("#2");
    await expect(row.getByTestId("outlier-detail")).toHaveText("1 review not submitted after the deadline");
    await expect(group(page, "late", "senior").getByTestId("outlier-row")).toHaveCount(0);
  });

  test("a row opens the person page", async ({ page }) => {
    await outlier(group(page, "silentOnSplit", "junior"), P.silent).click();
    await expect(page).toHaveURL(/\/people\/r-silent%40example\.org$/);
    await expect(page.getByTestId("person-name")).toHaveText("Sam Silvermoon");
  });
});

test.describe("person page", () => {
  test("R-silent: every paper, their score, no comments yet", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/people/${encodeURIComponent(P.silent)}`);
    await expect(page.getByTestId("person-tier")).toHaveText("Junior PC");
    const papers = page.getByTestId("person-paper");
    await expect(papers).toHaveCount(3);
    expect(await papers.evaluateAll((els) => els.map((e) => Number(e.getAttribute("data-pid"))))).toEqual([3, 4, 12]);
    for (const p of await papers.all()) {
      await expect(p.getByTestId("their-score")).toContainText("merit 2");
      await expect(p.getByTestId("last-comment")).toHaveText("no comments yet");
      await expect(p.getByTestId("flag-silent")).toBeVisible();
    }
    // The ACs' comments on 3, 4 and 12 count as pings (spec §5a), and R-silent never replies.
    await expect(page.getByTestId("person-outlier")).toHaveText(["No comments yet on split papers", "Unanswered pings"]);
    await expect(page.getByTestId("open-ping")).toHaveCount(3);
    await ready(page);
    await argosScreenshot(page, "person-r-silent");
  });

  test("R-pinged: the open ping on pid 4, 11+ days", async ({ page }) => {
    await page.goto(`/people/${encodeURIComponent(P.pinged)}`);
    const ping = page.locator('[data-testid="open-ping"][data-pid="4"]');
    // The episode starts at AC-busy's day +1 comment; the @mention is day +3 09:00.
    await expect(ping).toContainText("pinged since Feb 13");
    await expect(ping).toContainText("(@mentioned Feb 15, 09:00)");
    expect(await days(ping.getByTestId("ping-age"))).toBeGreaterThanOrEqual(11);
    await expect(page.locator('[data-testid="person-paper"][data-pid="4"]').getByTestId("flag-ping")).toBeVisible();
  });

  test("Hal: rating flags received, and the flagged reviews marked per paper", async ({ page }) => {
    await page.goto(`/people/${encodeURIComponent(PEOPLE.repeatedlyFlagged.email)}`);
    await expect(page.getByTestId("sum-ratings")).toHaveText("3× short, 1× disrespectful received · flags other than good on 2 papers");
    await expect(page.getByTestId("person-outlier")).toContainText(["Repeatedly flagged reviews"]);
    await expect(page.locator('[data-testid="person-paper"][data-pid="13"]').getByTestId("flag-rated")).toHaveText("rated 1× short, 1× disrespectful");
    await expect(page.locator('[data-testid="person-paper"][data-pid="10"]').getByTestId("flag-rated")).toHaveText("rated 2× short");
    await expect(page.locator('[data-testid="person-paper"][data-pid="6"]').getByTestId("flag-rated")).toHaveCount(0);
  });

  test("AC-idle: two papers as AC, no comments", async ({ page }) => {
    await page.goto(`/people/${encodeURIComponent(P.acIdle)}`);
    await expect(page.getByTestId("sum-ac")).toContainText("2 papers · 2 flagged · 0 comments since discussion opened");
    await expect(page.getByTestId("paper-role")).toHaveText(["AC", "AC"]);
  });

  test("an unknown person is a readable error", async ({ page }) => {
    await page.goto("/people/nobody%40example.org");
    await expect(page.getByTestId("person-error")).toContainText("no such person");
  });
});

test.describe("overview", () => {
  test("counts, spread, flagged per AC and the no-consensus burndown", async ({ page }) => {
    // Tall enough to hold the whole page (it scrolls inside <main>, so fullPage can't).
    await page.setViewportSize({ width: 1280, height: 1100 });
    await page.goto("/overview");
    await expect(page.getByTestId("count-papers").locator(".stat-value")).toHaveText("13");
    await expect(page.getByTestId("count-decided").locator(".stat-value")).toHaveText("1");
    await expect(page.getByTestId("count-reviewing").locator(".stat-value")).toHaveText("1");
    await expect(page.getByTestId("count-no-consensus").locator(".stat-value")).toHaveText("3");
    await expect(page.getByTestId("count-flagged").locator(".stat-value")).toHaveText("12");
    // Merit ranges: 0 (5, 6, 11), 1 (1, 2, 7, 8, 9, 10, 13), 2 (3, 4, 12).
    const bins = await page.getByTestId("bin").evaluateAll((els) => els.map((e) => [e.getAttribute("data-label"), Number(e.getAttribute("data-value"))]));
    expect(bins).toEqual([
      ["0", 3],
      ["1", 7],
      ["2", 3],
    ]);
    await expect(page.locator(`[data-testid="ov-ac"][data-email="${P.acBusy}"]`).getByTestId("ov-ac-load")).toHaveText("6 papers · 5 flagged");
    await expect(page.locator(`[data-testid="ov-ac"][data-email="${P.acIdle}"]`).getByTestId("ov-ac-load")).toHaveText("2 papers · 2 flagged");
    // The burndown ends at now with the three split papers, against the phase dates.
    await expect(page.getByTestId("end-noConsensus")).toHaveText("3 no consensus");
    await expect(page.getByTestId("end-undecided")).toHaveText("12 undecided");
    const markers = await page.getByTestId("marker").evaluateAll((els) => els.map((e) => e.getAttribute("data-label")));
    expect(markers).toEqual(["Reviews due", "Response opens", "Response closes", "Discussion opens", "Now", "Discussion closes", "Decisions due"]);
    await ready(page);
    await argosScreenshot(page, "overview");
  });
});

test.describe("triage polish", () => {
  test("every reason chip is fully visible, even with three on a row", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("triage-row")).toHaveCount(13);
    const clipped = await page.getByTestId("chip").evaluateAll((chips) =>
      chips
        .filter((c) => {
          const cell = c.closest('[role="cell"]')!.getBoundingClientRect();
          const r = c.getBoundingClientRect();
          return r.left < cell.left || r.right > cell.right || r.top < cell.top || r.bottom > cell.bottom;
        })
        .map((c) => c.textContent),
    );
    expect(clipped).toEqual([]);
    await expect(page.locator('[data-testid="triage-row"][data-pid="5"] [data-rule="AC_ABSENT"]')).toBeInViewport({ ratio: 1 });
  });
});

test("nav links to Triage, ACs, Reviewers and Overview", async ({ page }) => {
  await page.goto("/");
  const nav = page.getByTestId("nav");
  await expect(nav.getByRole("link")).toHaveText(["Triage", "ACs", "Reviewers", "Overview"]);
  await nav.getByRole("link", { name: "ACs" }).click();
  await expect(page).toHaveURL(/\/acs$/);
  await nav.getByRole("link", { name: "Overview" }).click();
  await expect(page.getByTestId("overview")).toBeVisible();
  await nav.getByRole("link", { name: "Reviewers" }).click();
  await expect(page.getByTestId("outlier-list")).toHaveCount(5);
  for (const path of ["/acs", "/reviewers", "/overview", `/people/${encodeURIComponent(P.silent)}`]) {
    await page.goto(path);
    const text = (await page.locator("main").innerText()).toLowerCase();
    for (const word of ["disengaged", "absent", "lazy"]) expect(text, path).not.toContain(word);
  }
});
