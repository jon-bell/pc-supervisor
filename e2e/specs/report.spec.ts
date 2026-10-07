// PLAN M13 smoke: the Report page over golden (PCS_NOW 2030-02-26, so the
// report is provisional; tiers junior and reciprocal have 1 reviewer each and
// are withheld under PCS_REPORT_MIN_CELL=5). Every section renders; the page
// lists no names, emails, or titles; the Export button downloads a zip whose
// files carry no "@" and nothing identifying; the do-not-invite link downloads.
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { scenario as golden } from "@pcs/seed/scenarios/golden/scenario";
import { findSensitive, sensitiveStrings } from "@pcs/seed/sensitive";
import { unzip } from "@pcs/server/modules/report/zip";

const SENSITIVE = sensitiveStrings(golden);

test.describe("Process report", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("nav-modules").getByRole("link", { name: "Report" }).click();
    await expect(page).toHaveURL(/\/modules\/report$/);
    await expect(page.getByTestId("report")).toBeVisible();
  });

  test("renders every section, provisional, with small tiers withheld", async ({ page }) => {
    await expect(page.getByTestId("report-status")).toHaveAttribute("data-final", "0");
    for (const id of ["report-totals", "report-depth", "report-timeliness", "report-merits", "report-ratings", "report-agreement", "report-reserve", "report-early-reject", "report-quick-reject", "report-dni", "report-export"]) {
      await expect(page.getByTestId(id)).toBeVisible();
    }
    await expect(page.getByTestId("total-papers").locator(".stat-value")).toHaveText("12");
    const depth = (tier: string) => page.locator(`[data-testid="depth-row"][data-tier="${tier}"]`);
    await expect(depth("senior")).toHaveAttribute("data-suppressed", "0");
    await expect(depth("junior")).toHaveAttribute("data-suppressed", "1");
    await expect(depth("reciprocal")).toContainText("fewer than 5 people; withheld");
    await expect(page.getByTestId("depth-histogram-senior")).toBeVisible();
    await expect(page.getByTestId("merit-histogram-senior").getByTestId("bin")).not.toHaveCount(0);
    await expect(page.getByTestId("report-reserve").getByTestId("suppressed")).toBeVisible();
    await expect(page.getByTestId("quick-reject-kv")).toBeVisible();
  });

  test("the page names no one", async ({ page }) => {
    const text = await page.getByTestId("report").innerText();
    expect(text).not.toContain("@");
    expect(findSensitive(text, SENSITIVE)).toBeNull();
  });

  test("Export downloads a zip of pseudonymous files; the do-not-invite CSV downloads too", async ({ page }) => {
    const [dl] = await Promise.all([page.waitForEvent("download"), page.getByTestId("export-zip").click()]);
    expect(dl.suggestedFilename()).toMatch(/^pcs-export-\d{4}-\d{2}-\d{2}\.zip$/);
    const files = unzip(readFileSync((await dl.path())!));
    expect([...files.keys()]).toEqual(["reviews.csv", "reviewers.csv", "manifest.csv", "README.txt"]);
    for (const [name, buf] of files) {
      const s = buf.toString("utf8");
      expect(s, name).not.toContain("@");
      expect(findSensitive(s, SENSITIVE), name).toBeNull();
    }
    const reviews = files.get("reviews.csv")!.toString("utf8").trimEnd().split("\n");
    expect(reviews.length).toBeGreaterThan(30);
    expect(reviews.slice(1).every((l) => /^[0-9a-f]{64},[0-9a-f]{16},/.test(l))).toBe(true);

    const [dni] = await Promise.all([page.waitForEvent("download"), page.getByTestId("dni-download").click()]);
    expect(dni.suggestedFilename()).toMatch(/^do-not-invite-.*\.csv$/);
    expect(readFileSync((await dni.path())!, "utf8").split("\n")[0]).toBe("email,reason,source");
  });
});
