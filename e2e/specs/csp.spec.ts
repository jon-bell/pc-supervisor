// The app under its real CSP (the "csp" project: no bypassCSP, no Argos
// screenshots). Every other project bypasses the CSP so Argos can inject its
// stabilization script, so a CSP-induced breakage (an inline style or script,
// an external font) would pass there; here any securitypolicyviolation event
// or console CSP error fails the test.
import { expect, test, type Page } from "@playwright/test";
import { PAGES } from "../support/pages.js";

const CSP_MESSAGE = /Content[- ]Security[- ]Policy|securitypolicyviolation/i;

/** Collect CSP violations (DOM events and console errors) and page errors from here on. */
async function watch(page: Page): Promise<string[]> {
  const problems: string[] = [];
  await page.addInitScript(() => {
    const w = window as unknown as { __cspViolations: string[] };
    w.__cspViolations = [];
    document.addEventListener("securitypolicyviolation", (e) => {
      w.__cspViolations.push(`${e.violatedDirective} blocked ${e.blockedURI || "(inline)"} at ${e.sourceFile}:${e.lineNumber}`);
    });
  });
  page.on("console", (m) => {
    if ((m.type() === "error" || m.type() === "warning") && CSP_MESSAGE.test(m.text())) problems.push(`console: ${m.text()}`);
  });
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  return problems;
}

async function violations(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __cspViolations?: string[] }).__cspViolations ?? []);
}

test("the CSP is enforced: no bypass in this project", async ({ page }) => {
  await page.goto("/");
  // An inline script is blocked under the real CSP (it would run with bypassCSP).
  const ran = await page.evaluate(() => {
    const s = document.createElement("script");
    s.textContent = "window.__inlineRan = true;";
    document.head.append(s);
    return (window as unknown as { __inlineRan?: boolean }).__inlineRan === true;
  });
  expect(ran).toBe(false);
});

for (const path of PAGES) {
  test(`no CSP violations on ${path}`, async ({ page }) => {
    const problems = await watch(page);
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    await expect(page.locator("main")).toBeVisible();
    if (path.startsWith("/papers/")) await expect(page.getByTestId("drawer-title")).not.toHaveText("Loading…");
    // Let late style/font loads report.
    await page.waitForTimeout(250);
    expect([...problems, ...(await violations(page))]).toEqual([]);
  });
}

test("opening the drawer from triage causes no CSP violations", async ({ page }) => {
  const problems = await watch(page);
  await page.goto("/");
  await page.getByTestId("triage-row").first().click();
  await expect(page.getByTestId("paper-drawer")).toBeVisible();
  await expect(page.getByTestId("drawer-title")).not.toHaveText("Loading…");
  await page.waitForLoadState("networkidle");
  expect([...problems, ...(await violations(page))]).toEqual([]);
});
