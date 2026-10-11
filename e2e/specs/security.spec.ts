// The served app's headers: a CSP with no external origins, and no token, on
// every route. The /api list comes from the server's own ROUTES (listRoutes),
// so a new route is covered without touching this file; a route with a path
// parameter this file has no sample for fails the test until one is added.
import { expect, test, type APIResponse } from "@playwright/test";
import { P } from "@pcs/seed/scenarios/golden/scenario";
import { fixedClock } from "@pcs/server/clock";
import { loadConfig } from "@pcs/server/config";
import { EXPORT_FILE_NAMES } from "@pcs/server/modules/report/index";
import type { SyncStatus } from "@pcs/server/server/api-types";
import { listRoutes } from "@pcs/server/server/app";
import { memoryStore } from "@pcs/server/store/store";
import { E2E_ENV } from "../support/env.js";
import { PAGES } from "../support/pages.js";

/** Sample values for each path parameter (golden scenario). */
const SAMPLES: Readonly<Record<string, readonly string[]>> = {
  pid: ["4", "99"],
  email: [P.silent, "nobody@example.org"],
  file: [...EXPORT_FILE_NAMES],
  cid: ["1", "999999"],
};

function expand(url: string): string[] {
  const m = /:(\w+)/.exec(url);
  if (!m) return [url];
  const samples = SAMPLES[m[1]!];
  if (!samples) throw new Error(`security.spec.ts: add a sample for :${m[1]} (route ${url})`);
  return samples.flatMap((v) => expand(url.replace(m[0], encodeURIComponent(v))));
}

async function apiRoutes(): Promise<{ method: string; url: string }[]> {
  const cfg = loadConfig({ ...process.env, ...E2E_ENV, PCS_DB_KEY: "unused" });
  const store = memoryStore();
  try {
    return await listRoutes({ cfg, store, clock: fixedClock(cfg.now ?? new Date(0)) });
  } finally {
    store.close();
  }
}

test("the app is served with a same-origin-only CSP and never carries the token, on every route", async ({ request }) => {
  test.setTimeout(120_000);
  const token = process.env.PCS_HOTCRP_TOKEN ?? "";
  expect(token.length).toBeGreaterThan(8);
  const check = async (what: string, r: APIResponse) => {
    expect(r.status(), what).toBeLessThan(500);
    const csp = r.headers()["content-security-policy"] ?? "";
    expect(csp, what).toContain("default-src 'self'");
    expect(csp, what).not.toMatch(/https?:|\*|unsafe/);
    expect((await r.body()).toString("latin1"), what).not.toContain(token);
    expect(JSON.stringify(r.headers()), what).not.toContain(token);
  };

  for (const url of PAGES) {
    const r = await request.get(url);
    expect(r.status(), url).toBe(200);
    await check(url, r);
  }

  const routes = await apiRoutes();
  // The module routes (M6, M11, M12, M13) are among them.
  const patterns = routes.map((r) => r.url);
  for (const u of ["/api/acs", "/api/reviewers", "/api/overview", "/api/people/:email", "/api/reserve", "/api/quickreject", "/api/tier-progress", "/api/early-reject", "/api/report"]) {
    expect(patterns).toContain(u);
  }

  let checked = 0;
  for (const { method, url } of routes) {
    for (const path of expand(url)) {
      const what = `${method} ${path}`;
      if (method === "GET") {
        await check(what, await request.get(path));
      } else if (method === "POST" && path === "/api/sync") {
        // Harmless: pinned clock, unchanged golden data (see sync.spec.ts). Wait for it to finish.
        await check(what, await request.post(path));
        await expect
          .poll(async () => ((await (await request.get("/api/sync/status")).json()) as SyncStatus).running, { timeout: 60_000 })
          .toBe(false);
      } else {
        // Writes (the tag routes): a cross-origin request is refused before anything happens.
        const r = await request.fetch(path, { method, data: {}, headers: { origin: "https://evil.example" } });
        expect(r.status(), what).toBe(403);
        await check(what, r);
      }
      checked++;
    }
  }
  expect(checked).toBeGreaterThan(20);
});
