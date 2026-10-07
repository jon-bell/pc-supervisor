// PLAN M11 acceptance on the local harness: seed the `registration` scenario
// (after a reset), verify it through the API, sync it into a fresh store,
// import the fixture CSVs, run reserve compliance (with a mocked DBLP lookup;
// no network) and the quick-reject tracker, and check that every planted
// problem is flagged and nothing else. The drafted Mail-tool searches are run
// through GET /search to check HotCRP reads them as the intended papers.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixedClock } from "@pcs/server/clock";
import { loadConfig, type Config } from "@pcs/server/config";
import { clientFromConfig } from "@pcs/server/hotcrp/client";
import { importCsv } from "@pcs/server/imports/store";
import { validateAssignments } from "@pcs/server/modules/assignment/index";
import { quickRejectReport } from "@pcs/server/modules/quickreject/index";
import { HintCache, reserveHintNames, reserveReport, staticLookup } from "@pcs/server/modules/reserve/index";
import { openStore, type Store } from "@pcs/server/store/store";
import { clientSource } from "@pcs/server/sync/source";
import { runSync } from "@pcs/server/sync/sync";
import { buildSnapshot } from "@pcs/server/views/snapshot";
import { seedContextFromEnv, seedScenario } from "../../src/driver.js";
import { resolveWhen } from "../../src/time.js";
import { verifyScenario } from "../../src/verify.js";
import {
  EXPECTED_BY_NAME,
  EXPECTED_HINTS,
  EXPECTED_QR_ITEMS,
  EXPECTED_QR_MAIL,
  EXPECTED_QR_OVERDUE,
  EXPECTED_RESERVE_FINDINGS,
  EXPECTED_RESERVE_MAIL,
  EXPECTED_RESERVE_STATES,
  summarizeQr,
  summarizeReserve,
} from "../../scenarios/registration/expected.js";
import { DBLP_MOCK, FIXTURES, OBSERVE_AT, R, registrationEnv, scenario } from "../../scenarios/registration/scenario.js";

const sc = seedContextFromEnv();
let dir: string;
let store: Store;
let cfg: Config;
const clock = fixedClock(resolveWhen(OBSERVE_AT, sc.ctx));

beforeAll(async () => {
  await seedScenario(scenario, { reset: true });
  dir = mkdtempSync(join(tmpdir(), "pcs-m11-int-"));
  cfg = loadConfig({ ...process.env, ...registrationEnv(sc.ctx), PCS_DB_PATH: join(dir, "pcs.db"), PCS_DB_KEY: "m11-integration-key" });
  store = openStore(cfg);
  const r = await runSync(store.db, clientSource(clientFromConfig(cfg.hotcrp)), {
    clock,
    chunkSize: cfg.sync.chunk,
    concurrency: cfg.sync.concurrency,
    tierTags: cfg.tierTags,
    acRole: cfg.acRole,
  });
  expect(r.ok, r.errors.join("; ")).toBe(true);
  for (const kind of ["tpms-registrations", "refcheck"] as const) {
    expect(importCsv(store.db, kind, readFileSync(FIXTURES[kind]), { tz: cfg.tz, clock }).ok).toBe(true);
  }
}, 180_000);

afterAll(() => {
  store?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("registration scenario: seeding and sync", () => {
  it("the harness holds exactly the scenario (options, tags, rounds, decisions included)", async () => {
    expect((await verifyScenario(scenario, sc.ctx)).problems).toEqual([]);
  });

  it("sync stores the paper tags and the quick-reject round", () => {
    const tags = store.db.prepare("select tags from paper where pid = 17").get() as { tags: string };
    expect((JSON.parse(tags.tags) as string[]).map((t) => t.replace(/#.*$/, "")).sort()).toEqual(
      ["qr-ac-reject", "qr-appeal", "qr-appeal-overturned", "qr-chair-desk-reject", "qr-flag"],
    );
    const rounds = store.db.prepare("select pid, round from review where round is not null and rtype != 5 order by pid").all();
    expect(rounds).toEqual([13, 14, 16, 20].map((pid) => ({ pid, round: "quickreject" })));
  });
});

describe("registration scenario: reserve compliance", () => {
  it("flags every planted problem, and nothing else", () => {
    const r = reserveReport(store, cfg, { clock });
    expect(summarizeReserve(r)).toEqual([...EXPECTED_RESERVE_FINDINGS].sort());
    for (const p of r.papers) expect([p.pid, p.state]).toEqual([p.pid, EXPECTED_RESERVE_STATES[p.pid] ?? "designee"]);
    const byName = r.papers.find((p) => p.pid === EXPECTED_BY_NAME.pid)!;
    expect([byName.designee, byName.identifiedBy]).toEqual([EXPECTED_BY_NAME.email, "name"]);
    expect(Object.fromEntries(r.mailDrafts.map((d) => [d.code, d.search]))).toEqual(EXPECTED_RESERVE_MAIL);
    expect(r.papers.find((p) => p.pid === 1)!.seniorityNote).toMatch(/PC member/);
    for (const f of r.findings) expect(f.reason).toMatch(/\d/);
    expect(r.notes).toEqual([]);
    expect(r.dblp.enabled).toBe(false);
  });

  it("with DBLP enabled (mocked lookup), hints attach without changing the findings", async () => {
    const dcfg = { ...cfg, reserve: { ...cfg.reserve!, dblp: { ...cfg.reserve!.dblp, enabled: true } } };
    const looked: string[] = [];
    const mock = staticLookup("DBLP (mock)", DBLP_MOCK);
    const cache = new HintCache({ label: mock.label, lookup: (n) => (looked.push(n), mock.lookup(n)) }, { rps: 1000, sleep: async () => {} });
    await cache.loadAll(reserveHintNames(store, dcfg, clock));
    const r = reserveReport(store, dcfg, { clock, cache });
    expect(summarizeReserve(r)).toEqual([...EXPECTED_RESERVE_FINDINGS].sort());
    const p11 = r.papers.find((p) => p.pid === 11)!;
    expect(p11.hints.map((h) => ({ name: h.name, atVenues: h.atVenues, possiblySenior: h.possiblySenior }))).toEqual(EXPECTED_HINTS.paper11);
    expect(r.designees.filter((d) => d.hint).map((d) => ({ email: d.email, atVenues: d.hint!.atVenues, possiblySenior: d.hint!.possiblySenior }))).toEqual(
      EXPECTED_HINTS.designees,
    );
    expect(r.dblp).toMatchObject({ enabled: true, pending: 0, failed: 0 });
    // Only names were looked up: never an email.
    expect(looked.length).toBeGreaterThan(0);
    for (const n of looked) expect(n).not.toMatch(/@/);
  });

  it("HotCRP reads each drafted Mail-tool search as exactly its papers", async () => {
    const client = clientFromConfig(cfg.hotcrp);
    for (const d of reserveReport(store, cfg, { clock }).mailDrafts) {
      const res = await client.search({ q: d.search, t: "all" });
      expect(res.ids, d.code).toEqual(d.search.split(" ").map(Number));
    }
  });
});

describe("registration scenario: quick-reject tracker", () => {
  it("queues exactly the planted items, with their states, and the overdue review", () => {
    const r = quickRejectReport(store, cfg, { clock });
    const s = summarizeQr(r);
    expect(s.items).toEqual(EXPECTED_QR_ITEMS);
    expect(s.overdue).toEqual(EXPECTED_QR_OVERDUE);
    expect(s.mail).toEqual(EXPECTED_QR_MAIL);
    for (const i of r.items) {
      expect(i.appealState).toBeDefined();
      expect(i.acs).toEqual([R.acS]);
      for (const sig of i.signals) expect(Object.keys(sig.evidence).length).toBeGreaterThan(0);
    }
    expect(r.notes).toEqual([]);
  });

  it("quick-reject reviews fill no review slots (PCS_QR_EXCLUDE_FROM_SLOTS)", () => {
    const snap = buildSnapshot(store, { fields: cfg.fields, acRole: cfg.acRole, excludeRounds: ["quickreject"] });
    expect(snap.reviews.filter((x) => x.rtype !== 5)).toEqual([]);
    expect(validateAssignments(store, cfg, { source: "hotcrp", clock }).counts.rows).toBe(0);
    const counted = loadConfig({ ...process.env, ...registrationEnv(sc.ctx), PCS_QR_EXCLUDE_FROM_SLOTS: "false", PCS_DB_PATH: join(dir, "x.db") });
    expect(validateAssignments(store, counted, { source: "hotcrp", clock }).counts.rows).toBe(4);
  });
});
