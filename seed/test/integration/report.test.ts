// PLAN M13 acceptance on the local harness: seed `shadow` (after a reset),
// sync, and render the process report (all sections present, sane numbers)
// at the scenario's instant (provisional) and after decisions (final); then
// GET /api/report and the export routes over the same store, and the
// pseudonymous export: no "@" and no name, email, title, or affiliation from
// the scenario in any cell; HMAC pseudonyms only, stable for a key, different
// across keys. The `scale` scenario (2,400 papers) is covered by
// `npm run test:scale` (e2e/scale/run.ts), which renders the same report and
// export over the scale store.
//
// RESETS the harness. Temp DB (never PCS_DB_PATH).

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixedClock } from "@pcs/server/clock";
import { loadConfig, type Config } from "@pcs/server/config";
import { clientFromConfig } from "@pcs/server/hotcrp/client";
import { importCsv } from "@pcs/server/imports/store";
import {
  doNotInviteCsv,
  EXPORT_FILE_NAMES,
  exportFiles,
  processReport,
  pseudonym,
  unzip,
  type ExportFiles,
  type ProcessReport,
} from "@pcs/server/modules/report/index";
import { buildApp } from "@pcs/server/server/app";
import { openStore, type Store } from "@pcs/server/store/store";
import { clientSource } from "@pcs/server/sync/source";
import { runSync } from "@pcs/server/sync/sync";
import { seedContextFromEnv, seedScenario } from "../../src/driver.js";
import { findSensitive, sensitiveStrings } from "../../src/sensitive.js";
import { resolveWhen } from "../../src/time.js";
import { scenario as shadow } from "../../scenarios/shadow/scenario.js";

const KEY = "integration-pseudonym-key-0001";
const KEY2 = "integration-pseudonym-key-0002";
const sc = seedContextFromEnv();
const now = resolveWhen(shadow.stages.at(-1)!.now!, sc.ctx);
const after = new Date(sc.ctx.phases.decisionsDue.getTime() + 86_400_000);
const S = sensitiveStrings(shadow);
let dir: string;
let cfg: Config;
let store: Store;
let provisional: ProcessReport;
let final: ProcessReport;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "pcs-m13-int-"));
  cfg = loadConfig({
    ...process.env,
    PCS_DB_PATH: join(dir, "pcs.db"),
    PCS_DB_KEY: "m13-integration-key",
    PCS_NOW: undefined,
    PCS_TIER_TAGS: "junior=junior,reciprocal=reciprocal",
    PCS_PSEUDONYM_KEY: KEY,
  });
  store = openStore(cfg);
  await seedScenario(shadow, { reset: true });
  const r = await runSync(store.db, clientSource(clientFromConfig(cfg.hotcrp)), {
    clock: fixedClock(now),
    chunkSize: cfg.sync.chunk,
    concurrency: cfg.sync.concurrency,
    tierTags: cfg.tierTags,
    acRole: cfg.acRole,
  });
  expect(r.ok, r.errors.join("; ")).toBe(true);
  const dni = readFileSync(new URL("../../fixtures/imports/do-not-invite.csv", import.meta.url));
  expect(importCsv(store.db, "do-not-invite", dni, { tz: cfg.tz, clock: fixedClock(now), fileName: "do-not-invite.csv" }).ok).toBe(true);
  provisional = processReport(store, cfg, fixedClock(now));
  final = processReport(store, cfg, fixedClock(after));
}, 240_000);

afterAll(() => {
  store?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const clean = (text: string, what: string) => {
  expect(text.includes("@"), `${what} contains "@"`).toBe(false);
  expect(findSensitive(text, S), what).toBeNull();
};

describe("process report over shadow", () => {
  it("is provisional at the scenario instant and final after decisions", () => {
    expect(provisional).toMatchObject({ final: false, phase: "discussion" });
    expect(final).toMatchObject({ final: true, phase: "after-decisions" });
  });

  it("every section is present with sane numbers", () => {
    for (const r of [provisional, final]) {
      expect(r.tiers).toEqual(["senior", "junior", "reciprocal"]);
      expect(r.totals.papers).toBe(150);
      expect(r.totals.reviewerReviews).toBeGreaterThanOrEqual(400);
      expect(r.totals.submitted).toBeGreaterThan(r.totals.reviewerReviews * 0.7);
      expect(r.totals.submitted).toBeLessThanOrEqual(r.totals.reviewerReviews);
      // 45 senior, 15 junior, 10 reciprocal reviewers: no tier is small.
      for (const sec of [r.depth.rows, r.timeliness.rows, r.merits.rows, r.ratings.rows, r.agreement.rows]) {
        expect(sec.map((x) => x.tier)).toEqual(r.tiers);
        for (const row of sec) expect(row).toMatchObject({ suppressed: false });
      }
      const ppl = Object.fromEntries(r.depth.rows.map((d) => [d.tier, d.people]));
      expect(ppl.senior).toBeGreaterThan(30);
      expect(ppl.junior).toBeGreaterThanOrEqual(10);
      expect(ppl.reciprocal).toBeGreaterThanOrEqual(5);
      for (const d of r.depth.rows) {
        expect(d.median!).toBeGreaterThan(0);
        expect(d.p25!).toBeLessThanOrEqual(d.median!);
        expect(d.median!).toBeLessThanOrEqual(d.p75!);
        expect(d.bins!.reduce((a, b) => a + b.count, 0)).toBe(d.reviews);
      }
      const sumReviews = r.depth.rows.reduce((a, d) => a + d.reviews!, 0);
      expect(sumReviews).toBe(r.totals.submitted);
      for (const t of r.timeliness.rows) {
        expect(t.submitted! + t.notSubmitted!).toBe(t.assigned);
        expect(t.onTime! + t.late!).toBeLessThanOrEqual(t.submitted!);
        expect(t.onTimeShare!).toBeGreaterThanOrEqual(0);
        expect(t.onTimeShare!).toBeLessThanOrEqual(1);
      }
      for (const m of r.merits.rows) expect(m.bins!.reduce((a, b) => a + b.count, 0)).toBe(m.reviews);
      for (const a of r.agreement.rows) {
        expect(a.meanAbsDev!).toBeGreaterThanOrEqual(0);
        expect(a.meanAbsDev!).toBeLessThan(3);
      }
      expect(r.reserve).toMatchObject({ suppressed: false, tiers: ["reserve-active", "reciprocal", "reserve-pool"] });
      expect(r.reserve.assigned!).toBeGreaterThan(0);
      expect(r.reserve.dropoutRate!).toBeGreaterThanOrEqual(0);
      expect(r.reserve.dropoutRate!).toBeLessThanOrEqual(1);
      expect(r.earlyReject).toMatchObject({ status: "unconfigured", candidates: 0 });
      expect(r.quickReject).toMatchObject({ available: true });
      expect(r.doNotInvite.run).toMatchObject({ rows: 3 });
      expect(r.export).toMatchObject({ keyConfigured: true });
    }
    // Decisions in shadow are early, clear-consensus ones: agreement with them is high.
    const decided = final.agreement.rows.filter((a) => a.decided! > 0);
    expect(decided.length).toBeGreaterThan(0);
    for (const a of decided) expect(a.share!).toBeGreaterThan(0.5);
    expect(final.totals.decided).toBe(final.totals.accepted + final.totals.rejected);
  });

  it("names no one", () => {
    clean(JSON.stringify(provisional), "the report JSON");
  });
});

describe("the API over shadow", () => {
  it("GET /api/report and the zip download", async () => {
    const { app } = await buildApp({ cfg, store, clock: fixedClock(after), webDir: null });
    try {
      const r = await app.inject({ method: "GET", url: "/api/report" });
      expect(r.statusCode).toBe(200);
      clean(r.body, "/api/report");
      expect(r.body).not.toContain(cfg.hotcrp.token);
      expect(r.body).not.toContain(KEY);
      const z = await app.inject({ method: "GET", url: "/api/report/export.zip" });
      expect(z.statusCode).toBe(200);
      const files = unzip(z.rawPayload);
      expect([...files.keys()]).toEqual([...EXPORT_FILE_NAMES]);
      for (const [n, b] of files) clean(b.toString("utf8"), n);
    } finally {
      await app.close();
    }
  });
});

describe("pseudonymous export over shadow", () => {
  let a: ExportFiles;
  beforeAll(() => {
    a = exportFiles(store, cfg, fixedClock(after));
  });

  it("no cell holds '@' or any name, email, title, or affiliation from the scenario", () => {
    for (const name of EXPORT_FILE_NAMES) {
      for (const line of a[name].split("\n")) {
        for (const cell of name.endsWith(".csv") ? line.split(",") : [line]) {
          expect(cell.includes("@"), `${name}: a cell has "@"`).toBe(false);
          expect(findSensitive(cell, S), name).toBeNull();
        }
      }
    }
  });

  it("every person column is an HMAC pseudonym of a scenario reviewer", () => {
    const reviewers = new Map(shadow.people.map((p) => [pseudonym(KEY, p.email), p.email]));
    const rows = a["reviewers.csv"].trimEnd().split("\n").slice(1);
    expect(rows.length).toBeGreaterThanOrEqual(60);
    for (const l of rows) expect(reviewers.has(l.split(",")[0]!)).toBe(true);
    const rev = a["reviews.csv"].trimEnd().split("\n").slice(1);
    expect(rev.length).toBe(final.totals.reviewerReviews);
    for (const l of rev) expect(reviewers.has(l.split(",")[0]!)).toBe(true);
  });

  it("is stable for a key and differs across keys", () => {
    const b = exportFiles(store, cfg, fixedClock(after));
    expect(b).toEqual(a);
    const c = exportFiles(store, { ...cfg, report: { ...cfg.report!, pseudonymKey: KEY2 } }, fixedClock(after));
    const ids = (f: ExportFiles) => new Set(f["reviewers.csv"].trimEnd().split("\n").slice(1).map((l) => l.split(",")[0]));
    const ia = ids(a);
    for (const x of ids(c)) expect(ia.has(x)).toBe(false);
    expect(ids(c).size).toBe(ia.size);
  });

  it("the do-not-invite carry-forward keeps the chair's list as imported", () => {
    const d = doNotInviteCsv(store, after);
    expect(d.rows).toBe(3);
    expect(d.csv.split("\n")[0]).toBe("email,reason,source");
    expect(d.csv).toContain("mallory.stone@example.org");
  });
});
