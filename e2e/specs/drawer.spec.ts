// PLAN M5 against golden: the paper drawer timeline (paper 4's day +3 ping).
import { argosScreenshot } from "@argos-ci/playwright";
import { expect, test } from "@playwright/test";
import { PEOPLE } from "@pcs/seed/scenarios/golden/expected";
import { resolveWhen } from "@pcs/seed/time";
import { loadPhaseConfig } from "@pcs/server/config";

const HOTCRP = (process.env.PCS_HOTCRP_URL ?? "").replace(/\/+$/, "");
const phases = loadPhaseConfig();
const fmt = (ms: number) =>
  new Intl.DateTimeFormat("en-US", { timeZone: phases.tz, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(ms);

test("paper 4's drawer shows the day +3 AC comment that @mentions R-pinged", async ({ page }) => {
  const ping = PEOPLE.unansweredPings[0];
  await page.goto("/");
  await page.locator('[data-testid="triage-row"][data-pid="4"]').click();
  await expect(page).toHaveURL(/\/papers\/4$/);
  const drawer = page.getByTestId("paper-drawer");
  await expect(drawer).toHaveAttribute("data-pid", "4");
  await expect(drawer.getByTestId("drawer-reasons").getByTestId("chip")).toHaveCount(2);

  const comments = drawer.getByTestId("timeline-comment");
  const pingItem = comments.filter({ has: page.getByTestId("mentions") });
  await expect(pingItem).toHaveCount(1);
  await expect(pingItem).toContainText("Comment by Avery Busyfield AC");
  await expect(pingItem.getByTestId("mentions")).toHaveText(" · mentions @Pat Pingleton");
  await expect(pingItem.getByTestId("word-count")).toHaveText(/^\d+ words$/);
  const when = resolveWhen({ phase: "discussionOpen", day: ping.day, time: "09:00" }, phases).getTime();
  await expect(pingItem.locator("time")).toHaveText(new RegExp(`^~?${fmt(when)}$`));

  // The timeline holds the three reviews, then discussion; R-pinged never comments here.
  await expect(drawer.getByTestId("timeline-review")).toHaveCount(3);
  await expect(comments.filter({ hasText: "by Pat Pingleton" })).toHaveCount(0);
  // Review deep links point at PCS_HOTCRP_URL.
  const links = await drawer.getByTestId("review-link").evaluateAll((els) => els.map((e) => e.getAttribute("href")));
  expect(links.sort()).toEqual([`${HOTCRP}/review/4A`, `${HOTCRP}/review/4B`, `${HOTCRP}/review/4C`]);
  await expect(drawer.getByTestId("drawer-hotcrp-link")).toHaveAttribute("href", `${HOTCRP}/paper/4`);

  await argosScreenshot(page, "paper-4-drawer");
});

test("drawers deep-link and show score changes, the response, and the decision", async ({ page }) => {
  await page.goto("/papers/3");
  const d3 = page.getByTestId("paper-drawer");
  await expect(d3.getByTestId("timeline-score")).toHaveText(/Sam Silvermoon.*changed merit 1 → 2/);
  await page.goto("/papers/11");
  await expect(page.getByTestId("paper-drawer").getByTestId("timeline-response")).toContainText("Author response by");
  await page.goto("/papers/1");
  await expect(page.getByTestId("paper-drawer").getByTestId("drawer-no-reasons")).toBeVisible();
  await expect(page.getByTestId("paper-drawer").getByTestId("timeline-decision")).toContainText("Decision: Accepted");
  await page.getByTestId("drawer-close").click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId("paper-drawer")).toHaveCount(0);
});
