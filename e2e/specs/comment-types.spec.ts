// Comment types against golden (spec §5e): the drawer's type chips, a relabel
// in the drawer (persisted, audited, counted in the AC pings column), back to
// the classifier, and the documented COMMENT_TYPE_CASE rule option. Writes
// only the app's local DB (never HotCRP), so it runs in the "rules" project
// after the read-only specs, and restores what it changed.
import { expect, test, type Page } from "@playwright/test";
import { P } from "@pcs/seed/scenarios/golden/scenario";
import { COMMENT_TYPE_CASE, FIRES_AT_PRIMARY } from "@pcs/seed/scenarios/golden/expected";
import type { RulesResponse } from "@pcs/server/server/rules-types";

test.describe.configure({ mode: "serial" });

const acRow = (page: Page, email: string) => page.locator(`[data-testid="ac-row"][data-email="${email}"]`);
const row = (page: Page, pid: number) => page.locator(`[data-testid="triage-row"][data-pid="${pid}"]`);
/** Pid 4's day +3 AC comment: the one that @mentions R-pinged. */
const pingComment = (page: Page) => page.getByTestId("timeline-comment").filter({ has: page.getByTestId("mentions") });

test.afterAll(async ({ request }) => {
  const r = (await (await request.get("/api/rules")).json()) as RulesResponse;
  if (r.revision && r.revision.overrideCount > 0) await request.post("/api/rules/revert", { data: { to: 0, note: "e2e cleanup" } });
});

test("the drawer shows each comment's type; relabelling one is saved, counted and audited", async ({ page }) => {
  await page.goto("/acs");
  await expect(page.getByRole("columnheader", { name: "Pings (heuristic)" })).toBeVisible();
  await expect(acRow(page, P.acBusy).getByTestId("ac-nudges")).toHaveText("1");

  await page.goto("/papers/4");
  const drawer = page.getByTestId("paper-drawer");
  await expect(drawer.getByTestId("classifier-note")).toHaveAttribute("data-active", "heuristic");
  await expect(drawer.getByTestId("classifier-note")).toContainText("pcs model fetch");
  const chip = pingComment(page).getByTestId("comment-type");
  await expect(chip).toHaveAttribute("data-kind", "ping");
  await expect(chip).toHaveAttribute("data-source", "heuristic");
  await expect(chip).toContainText(/Ping· heuristic \d+%/);
  // Every other comment on the paper is discussion (golden filler).
  const others = drawer.getByTestId("timeline-comment").filter({ hasNot: page.getByTestId("mentions") }).getByTestId("comment-type");
  for (const k of await others.evaluateAll((els) => els.map((e) => e.getAttribute("data-kind")))) expect(k).toBe("discussion");

  // Relabel: open the menu on the chip, one click on "Reply".
  await chip.click();
  const menu = page.getByTestId("relabel-menu");
  await expect(menu).toBeVisible();
  await menu.locator('[data-testid="relabel-option"][data-kind="reply"]').click();
  await expect(menu).toBeHidden();
  await expect(chip).toHaveAttribute("data-kind", "reply");
  await expect(chip).toHaveAttribute("data-source", "chair");
  await expect(chip).toContainText("your label");

  // Saved: a reload shows it, the AC's ping count drops, the relabel log has it.
  await page.reload();
  await expect(pingComment(page).getByTestId("comment-type")).toHaveAttribute("data-source", "chair");
  await page.goto("/acs");
  await expect(acRow(page, P.acBusy).getByTestId("ac-nudges")).toHaveText("0");
  await page.goto("/flag-history");
  const item = page.getByTestId("relabel-item").first();
  await expect(item).toHaveAttribute("data-kind", "reply");
  await expect(item).toContainText(/#4 comment \d+: ping \(heuristic\) → reply by /);

  // Back to the classifier.
  await page.goto("/papers/4");
  await pingComment(page).getByTestId("comment-type").click();
  await page.getByTestId("relabel-clear").click();
  await expect(pingComment(page).getByTestId("comment-type")).toHaveAttribute("data-source", "heuristic");
  await expect(pingComment(page).getByTestId("comment-type")).toHaveAttribute("data-kind", "ping");
  await page.goto("/acs");
  await expect(acRow(page, P.acBusy).getByTestId("ac-nudges")).toHaveText("1");
});

test("a rule can ignore non-substantive comments: the documented comment-type case", async ({ page }) => {
  const [key] = Object.keys(COMMENT_TYPE_CASE.changes);
  await page.goto("/rules");
  const card = page.locator('[data-testid="rule-card"][data-rule="AC_ABSENT"]');
  const field = card.locator(`[data-testid="setting"][data-key="${key}"]`);
  await expect(field).toContainText("env default off");
  await field.getByTestId("setting-input").check();
  const changes = page.getByTestId("preview-change");
  await expect(changes).toHaveCount(COMMENT_TYPE_CASE.changed.length);
  await expect(changes.first()).toHaveAttribute("data-pid", "13");
  await expect(changes.first()).toContainText("+No AC comment yet");
  await page.getByTestId("rules-save").click();
  await expect(page.getByTestId("rules-saved")).toContainText(/Saved revision #\d+: 1 flag raised, 0 cleared/);

  await page.goto("/");
  for (const [pid, rules] of Object.entries(FIRES_AT_PRIMARY)) {
    const want = COMMENT_TYPE_CASE.fires[Number(pid)] ?? rules;
    await expect(row(page, Number(pid))).toBeVisible();
    const got = await row(page, Number(pid)).getByTestId("chip").evaluateAll((els) => els.map((e) => e.getAttribute("data-rule")).sort());
    expect(got, `pid ${pid}`).toEqual([...want].sort());
  }
  await page.goto("/papers/13");
  await expect(page.getByTestId("drawer-reasons")).toContainText(COMMENT_TYPE_CASE.reason.includes);
  await expect(page.getByTestId("timeline-comment").getByTestId("comment-type").filter({ hasText: "Non-substantive" })).toHaveCount(1);
});
