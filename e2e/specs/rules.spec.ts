// Chair rule settings against golden (spec §5c, PLAN golden OVERRIDE_CASE):
// edit a threshold, see the live preview, save with a note, see triage
// update, see the revision and the flag history, then revert. Writes only
// the app's local DB (never HotCRP), so it runs in its own project after the
// read-only specs and leaves the env defaults in force (afterAll).
import { argosScreenshot } from "@argos-ci/playwright";
import { expect, test, type Page } from "@playwright/test";
import { FIRES_AT_PRIMARY, OVERRIDE_CASE } from "@pcs/seed/scenarios/golden/expected";
import type { RulesResponse } from "@pcs/server/server/rules-types";

test.describe.configure({ mode: "serial" });

const row = (page: Page, pid: number) => page.locator(`[data-testid="triage-row"][data-pid="${pid}"]`);
const chipRules = async (page: Page, pid: number) => {
  await expect(row(page, pid)).toBeVisible();
  return row(page, pid).getByTestId("chip").evaluateAll((els) => els.map((e) => e.getAttribute("data-rule")).sort());
};
const flaggedAtPrimary = Object.values(FIRES_AT_PRIMARY).filter((r) => r.length > 0).length;

test.beforeAll(async ({ request }) => {
  const r = (await (await request.get("/api/rules")).json()) as RulesResponse;
  expect(r.revision, "the e2e server starts on the env defaults").toBeNull();
  expect(r.counts.flagged).toBe(flaggedAtPrimary);
});

test.afterAll(async ({ request }) => {
  const r = (await (await request.get("/api/rules")).json()) as RulesResponse;
  if (r.revision && r.revision.overrideCount > 0) await request.post("/api/rules/revert", { data: { to: 0, note: "e2e cleanup" } });
});

test("edit a threshold, preview it, save it, and triage updates; then revert", async ({ page }) => {
  const [key, value] = Object.entries(OVERRIDE_CASE.changes)[0]!;
  await page.goto("/rules");
  const card = page.locator('[data-testid="rule-card"][data-rule="GONE_QUIET"]');
  await expect(card.getByTestId("rule-count")).toHaveAttribute("data-current", "2");
  const field = card.locator(`[data-testid="setting"][data-key="${key}"]`);
  await expect(field).toContainText("env default 4");
  await field.getByTestId("setting-input").fill(String(value));

  // Live preview: one paper fewer flagged; exactly the documented diff.
  await expect(page.getByTestId("preview-total-proposed")).toHaveText(String(flaggedAtPrimary - 1));
  await expect(card.getByTestId("rule-count-proposed")).toHaveText("1");
  const changes = page.getByTestId("preview-change");
  await expect(changes).toHaveCount(OVERRIDE_CASE.changed.length);
  await expect(changes.first()).toHaveAttribute("data-pid", "6");
  await expect(changes.first()).toContainText("unflagged");
  await expect(changes.first()).toContainText("−Gone quiet");
  await argosScreenshot(page, "rules-preview");

  // Nothing is saved yet.
  await page.goto("/");
  expect(await chipRules(page, 6)).toEqual(["GONE_QUIET"]);
  await page.goto("/rules");
  await page.locator(`[data-testid="setting"][data-key="${key}"]`).getByTestId("setting-input").fill(String(value));
  await page.getByTestId("rules-note").fill("a week and a half of quiet is normal here");
  await page.getByTestId("rules-save").click();
  await expect(page.getByTestId("rules-saved")).toContainText(/Saved revision #\d+: 0 flags raised, 1 cleared/);
  await expect(page.getByTestId("rules-revision")).toContainText(/Revision #\d+/);
  await expect(page.locator('[data-testid="rule-card"][data-rule="GONE_QUIET"]').getByTestId("rule-count")).toHaveAttribute("data-current", "1");
  await expect(page.locator(`[data-testid="setting"][data-key="${key}"]`)).toContainText("reset");

  // The revision, with its diff and note.
  const rev = page.getByTestId("revision").first();
  await expect(rev).toContainText(`${key} 4 (env default) → 13`);
  await expect(rev).toContainText("a week and a half of quiet is normal here");
  await expect(rev).toContainText("in force");

  // Triage: pid 6 no longer flagged; every other paper unchanged.
  await page.getByTestId("nav").getByRole("link", { name: "Triage" }).click();
  await expect(row(page, 6).getByTestId("chip")).toHaveCount(0);
  for (const [pid, rules] of Object.entries(FIRES_AT_PRIMARY)) {
    const want = OVERRIDE_CASE.fires[Number(pid)] ?? rules;
    expect(await chipRules(page, Number(pid)), `pid ${pid}`).toEqual([...want].sort());
  }

  // Flag history: the clear, attributed to the rule change.
  await page.goto("/flag-history?rule=GONE_QUIET");
  const clear = page.locator('[data-testid="fh-item"][data-pid="6"][data-kind="cleared"][data-cause="rules"]');
  await expect(clear).toHaveCount(1);
  await expect(clear).toContainText(/Gone quiet cleared after rule change #\d+/);
  await expect(page.getByTestId("fh-chart")).toBeVisible();
  await expect(page.locator('[data-testid="fh-summary-row"][data-rule="GONE_QUIET"] td').nth(1)).toHaveText("1");

  // The paper drawer's flag timeline.
  await page.goto("/papers/6");
  const span = page.getByTestId("paper-flag-timeline").locator('[data-testid="flag-span"][data-rule="GONE_QUIET"]').first();
  await expect(span).toHaveText(/^Gone quiet raised ~[A-Z][a-z]{2} \d+, cleared [A-Z][a-z]{2} \d+ after rule change #\d+$/);

  // Revert to the env defaults: golden again.
  await page.goto("/rules");
  await page.getByTestId("rules-reset-all").click();
  await expect(page.getByTestId("revision").first()).toContainText("reset to env defaults");
  await expect(page.locator('[data-testid="rule-card"][data-rule="GONE_QUIET"]').getByTestId("rule-count")).toHaveAttribute("data-current", "2");
  await page.goto("/");
  expect(await chipRules(page, 6)).toEqual(["GONE_QUIET"]);
});

test("the drawer and the feed show reconstructed history from the backfill", async ({ page }) => {
  // pid 5: no comments ever; silent since the first daily point after discussion opened.
  await page.goto("/papers/5");
  const silent = page.getByTestId("paper-flag-timeline").locator('[data-testid="flag-span"][data-rule="SILENT_DISCUSSION"]');
  await expect(silent).toHaveText(/^No comments yet since ~Feb 12$/);
  await page.goto("/flag-history");
  await expect(page.getByTestId("fh-item").first()).toBeVisible();
  await argosScreenshot(page, "flag-history");
});
