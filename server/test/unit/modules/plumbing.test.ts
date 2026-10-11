// M11 plumbing: config (PCS_RESERVE_*, PCS_DBLP_*, PCS_QR_*, PCS_REFCHECK_*),
// the store -> module loaders end to end on an in-memory store synced from a
// fake HotCRP, the quick-reject round left out of the review slots, the
// /api/reserve and /api/quickreject routes, and the CLI text. Synthetic data
// only; no network (the DBLP lookup is a fake).

import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { describeQuickReject, describeReserve } from "../../../src/cli/modules-command.js";
import { fixedClock } from "../../../src/clock.js";
import {
  DEFAULT_QUICKREJECT_POLICY,
  DEFAULT_RESERVE_POLICY,
  describeConfig,
  excludedRounds,
  loadConfig,
  type Config,
  type ConfigError,
} from "../../../src/config.js";
import type { Paper, SettingsSfResponse } from "../../../src/hotcrp/schemas.js";
import { importCsv } from "../../../src/imports/store.js";
import { validateAssignments } from "../../../src/modules/assignment/index.js";
import { quickRejectReport } from "../../../src/modules/quickreject/index.js";
import { HintCache, reserveReport, staticLookup } from "../../../src/modules/reserve/index.js";
import { analyze, ruleContextFromConfig } from "../../../src/rules/index.js";
import type { QuickRejectResponse, ReserveResponse } from "../../../src/server/api-types.js";
import { buildApp, type RouteDeps } from "../../../src/server/app.js";
import { makeRegisterModules } from "../../../src/server/routes/modules.js";
import { memoryStore, type Store } from "../../../src/store/store.js";
import { runSync } from "../../../src/sync/sync.js";
import { buildSnapshot } from "../../../src/views/snapshot.js";
import { BASE_ENV } from "../env.js";
import { FakeHotcrp } from "../fake-source.js";

const e = (s: string) => `${s}@example.org`;
const load = (over: Record<string, string> = {}) => loadConfig({ ...BASE_ENV, ...over }, { home: "/h" });
const problems = (over: Record<string, string>) => {
  try {
    load(over);
    return [];
  } catch (err) {
    return (err as ConfigError).problems.map((p) => `${p.name}: ${p.message}`);
  }
};

describe("config: reserve and quick-reject", () => {
  it("has the documented defaults", () => {
    const c = load();
    expect(c.reserve).toEqual(DEFAULT_RESERVE_POLICY);
    expect(c.quickReject).toEqual(DEFAULT_QUICKREJECT_POLICY);
    expect(c.reserve!.dblp.enabled).toBe(false);
    expect(c.reserve!.exemptions).toEqual(["no-eligible-author", "all-authors-on-pc", "other"]);
    expect(excludedRounds(c)).toEqual(["quickreject"]);
    expect(excludedRounds({ quickReject: { ...DEFAULT_QUICKREJECT_POLICY, excludeFromSlots: false } })).toEqual([]);
    expect(describeConfig(c).join("\n")).toMatch(/DBLP hint off/);
  });

  it("parses overrides", () => {
    const c = load({
      PCS_RESERVE_EXEMPTIONS: " on-leave , Other,other ",
      PCS_RESERVE_MAX_COVER: "5",
      PCS_DBLP_ENABLED: "true",
      PCS_DBLP_URL: "https://dblp.example.org/",
      PCS_DBLP_VENUES: "ICSE,ASE",
      PCS_QR_FIELD: "DeskRej",
      PCS_QR_AC_FLAG_TAG: "#flag-qr",
      PCS_QR_TAGS: "appeal=dr-appeal, ac-keep=keepme",
      PCS_QR_REJECT_DECISIONS: "Rejected,Desk rejected",
      PCS_QR_EXCLUDE_FROM_SLOTS: "false",
    });
    expect(c.reserve).toMatchObject({ exemptions: ["on-leave", "Other"], maxCover: 5, dblp: { enabled: true, url: "https://dblp.example.org", venues: ["ICSE", "ASE"] } });
    expect(c.quickReject).toMatchObject({
      field: "DeskRej",
      acFlagTag: "flag-qr",
      tags: { appeal: "dr-appeal", "ac-keep": "keepme", "ac-reject": "qr-ac-reject" },
      rejectDecisions: ["Rejected", "Desk rejected"],
      excludeFromSlots: false,
    });
    expect(load({ PCS_FIELD_MERIT: "Merit" }).quickReject!.field).toBe("Merit");
    expect(describeConfig(c).join("\n")).toMatch(/DBLP hint ON \(https:\/\/dblp.example.org; venues ICSE, ASE\)/);
  });

  it("rejects bad values", () => {
    expect(
      problems({
        PCS_DBLP_URL: "http://dblp.example.org",
        PCS_DBLP_RPS: "0",
        PCS_QR_ROUND: "quick reject",
        PCS_QR_TAGS: "nope=x",
        PCS_RESERVE_EXEMPTIONS: ",",
        PCS_REFCHECK_HALLUCINATED_MIN: "0",
      }),
    ).toEqual([
      'PCS_RESERVE_EXEMPTIONS: expected a comma-separated list of exemption names, got ","',
      "PCS_DBLP_URL: expected an https URL without credentials, query, or fragment, got \"http://dblp.example.org\"",
      'PCS_DBLP_RPS: expected a number greater than 0 and at most 10, got "0"',
      'PCS_QR_ROUND: expected a review round name like quickreject, got "quick reject"',
      'PCS_QR_TAGS: expected key=tag pairs with keys ac-reject, ac-keep, chair-desk-reject, chair-keep, appeal, appeal-upheld, appeal-overturned (tags: letters, digits, and _ . : -), got "nope=x"',
      'PCS_REFCHECK_HALLUCINATED_MIN: expected an integer from 1 to 100000, got "0"',
    ]);
    expect(problems({ PCS_QR_TAGS: "appeal=qr-ac-reject" })).toEqual([
      'PCS_QR_TAGS: every quick-reject state needs its own tag, got "appeal=qr-ac-reject"',
    ]);
  });
});

/** FakeHotcrp plus the submission endpoints (as in the M10 plumbing test). */
class FakeWithSubmissions extends FakeHotcrp {
  details: Paper[] = [];
  sf: SettingsSfResponse = { ok: true, settings: { sf: [] } };
  async paperDetails(q: string): Promise<Paper[]> {
    const m = /^(\d+)(?:-(\d+))?$/.exec(q)!;
    const [lo, hi] = [Number(m[1]), Number(m[2] ?? m[1])];
    return structuredClone(this.details.filter((p) => p.pid >= lo && p.pid <= hi));
  }
  async submissionFields(): Promise<SettingsSfResponse> {
    return structuredClone(this.sf);
  }
}

const T1 = new Date("2029-12-30T17:00:00Z");

function world(): FakeWithSubmissions {
  const f = new FakeWithSubmissions();
  f.people = [
    { name: "Ada Chair", email: e("ada"), chair: true },
    { name: "Ben Area", email: e("ben") },
    { name: "Quinn Lane", email: e("quinn") },
    { name: "Sam Senior", email: e("sam") },
  ];
  f.papersList = [
    { pid: 1, title: "One" },
    { pid: 2, title: "Two", tags: "#qr-flag #qr-ac-reject" },
    { pid: 3, title: "Three", tags: "#qr-ac-reject #qr-chair-desk-reject#0", decision: "Rejected" },
    { pid: 4, title: "Gone", status: "Withdrawn" },
  ];
  f.assignmentRows = [
    { paper: 1, action: "metareview", email: e("ben") },
    { paper: 2, action: "metareview", email: e("ben") },
    { paper: 1, action: "pcreview", email: e("quinn"), round: "quickreject" },
    { paper: 2, action: "pcreview", email: e("quinn"), round: "quickreject" },
    { paper: 2, action: "primaryreview", email: e("sam") },
  ];
  f.review({ pid: 1, rid: 1, reviewer_email: e("ben"), status: "empty", rtype: 5 });
  f.review({ pid: 2, rid: 2, reviewer_email: e("ben"), status: "empty", rtype: 5, round: "quickreject" });
  f.review({ pid: 1, rid: 3, reviewer_email: e("quinn"), status: "empty", rtype: 2, round: "quickreject" });
  f.review({ pid: 2, rid: 4, reviewer_email: e("quinn"), status: "complete", rtype: 2, round: "quickreject", OveMer: 1, RevExp: 2 } as never);
  f.review({ pid: 2, rid: 5, reviewer_email: e("sam"), status: "empty", rtype: 4 });
  f.sf = {
    ok: true,
    settings: {
      sf: [
        { id: 1, name: "Reserve designee", type: "text" },
        { id: 2, name: "Reserve exemption", type: "dropdown", values: [{ id: 1, name: "no-eligible-author" }, { id: 2, name: "other" }] },
      ],
    },
  };
  f.details = [
    { object: "paper", pid: 1, authors: [{ email: e("cleo"), given_name: "Cleo", family_name: "Ray" }], "Reserve designee": e("cleo") } as Paper,
    { object: "paper", pid: 2, authors: [{ email: e("dov"), given_name: "Dov", family_name: "Ash" }] } as Paper,
    { object: "paper", pid: 3, authors: [{ email: e("eve"), given_name: "Eve", family_name: "Lo" }], "Reserve exemption": "other" } as Paper,
    { object: "paper", pid: 4, authors: [{ email: e("fay"), given_name: "Fay", family_name: "Um" }] } as Paper,
  ];
  return f;
}

async function synced(): Promise<{ store: Store; cfg: Config }> {
  const cfg = load({ PCS_PHASE_QUICKREJECT_DUE: "2029-12-28T23:59", PCS_PHASE_ASSIGNMENT_DONE: "2030-01-11T23:59", PCS_NOW: "2029-12-30T12:00" });
  const store = memoryStore();
  const r = await runSync(store.db, world(), { clock: fixedClock(T1), chunkSize: 10, concurrency: 1, tierTags: {}, acRole: { kind: "meta" } });
  expect(r.ok, r.errors.join("; ")).toBe(true);
  return { store, cfg };
}

describe("modules over the store", () => {
  it("reserve: designees, missing, exemptions; withdrawn papers are skipped", async () => {
    const { store, cfg } = await synced();
    const r = reserveReport(store, cfg, { clock: fixedClock(cfg.now!) });
    expect(r.papers.map((p) => [p.pid, p.state, p.designee ?? p.exemption])).toEqual([
      [1, "designee", e("cleo")],
      [2, "noncompliant", null],
      [3, "exempt", "other"],
    ]);
    expect(r.findings.map((f) => f.code)).toEqual(["DESIGNEE_MISSING"]);
    importCsv(store.db, "tpms-registrations", "email,registered\ncleo@example.org,no\n", { tz: "UTC", clock: fixedClock(T1) });
    expect(reserveReport(store, cfg, { clock: fixedClock(cfg.now!) }).findings.map((f) => f.code)).toEqual(["DESIGNEE_MISSING", "TPMS_NOT_REGISTERED"]);
  });

  it("quick reject: verdicts from the round's reviews, states from tags, overdue after the due date", async () => {
    const { store, cfg } = await synced();
    importCsv(store.db, "refcheck", "pid,hallucinated_refs,in_field_refs\n1,2,4\n", { tz: "UTC", clock: fixedClock(T1) });
    const r = quickRejectReport(store, cfg, { clock: fixedClock(cfg.now!) });
    expect(r.items.map((i) => [i.pid, i.stage, i.signals.map((s) => s.kind), i.acDecision, i.chairAction, i.appealState, i.acs])).toEqual([
      [1, "ac-decision", ["refcheck"], "none", "none", "none", [e("ben")]],
      [2, "chair-action", ["ac-flag", "qr-verdict"], "reject", "none", "none", [e("ben")]],
      [3, "done", [], "reject", "desk-reject", "none", []],
    ]);
    expect(r.overdueReviews.map((o) => [o.pid, o.email, o.daysOverdue])).toEqual([[1, e("quinn"), 1.5]]);
    expect(r.counts).toMatchObject({ qrReviews: 2, qrReviewsSubmitted: 1 });
  });

  it("quick-reject reviews fill no review slots; PCS_QR_EXCLUDE_FROM_SLOTS=false counts them", async () => {
    const { store, cfg } = await synced();
    const snap = (rounds: string[]) => buildSnapshot(store, { fields: cfg.fields, acRole: cfg.acRole, excludeRounds: rounds });
    // Metareviews in the round (rid 2) stay; reviewer reviews in it (3, 4) go.
    expect(snap(excludedRounds(cfg)).reviews.map((r) => r.rid)).toEqual([1, 2, 5]);
    expect(snap(["QuickReject"]).reviews.map((r) => r.rid)).toEqual([1, 2, 5]);
    expect(snap([]).reviews.map((r) => r.rid).sort()).toEqual([1, 2, 3, 4, 5]);
    const late = { ...cfg, now: new Date("2030-02-05T12:00:00Z") };
    const ctx = ruleContextFromConfig(late, fixedClock(late.now));
    const missing = (rounds: string[]) => analyze(snap(rounds), ctx).evaluation.byPid.get(2)!.fired.find((x) => x.rule === "MISSING_REVIEWS")?.reason;
    expect(missing(excludedRounds(cfg))).toMatch(/^0 of 3 required reviews complete; 1 assigned review not submitted/);
    expect(missing([])).toMatch(/^1 of 3 required reviews complete; 1 assigned review not submitted/);
    expect(validateAssignments(store, cfg, { source: "hotcrp", clock: fixedClock(T1) }).counts.rows).toBe(1);
    const counted = { ...cfg, quickReject: { ...cfg.quickReject!, excludeFromSlots: false } };
    expect(validateAssignments(store, counted, { source: "hotcrp", clock: fixedClock(T1) }).counts.rows).toBe(3);
  });
});

describe("routes and CLI text", () => {
  it("GET /api/reserve and /api/quickreject answer with the report and the module window", async () => {
    const { store, cfg } = await synced();
    const api = await buildApp({ cfg, store, clock: fixedClock(cfg.now!), webDir: null });
    const res = await api.app.inject({ method: "GET", url: "/api/reserve" });
    expect(res.statusCode).toBe(200);
    const body = res.json<ReserveResponse>();
    expect(body.module).toMatchObject({ id: "reserve-compliance", letter: "A", active: false, phase: "assignment", window: { from: null, to: cfg.phases.quickRejectDue!.getTime() } });
    expect(body.counts).toMatchObject({ papers: 3, noncompliant: 1 });
    const qr = (await api.app.inject({ method: "GET", url: "/api/quickreject" })).json<QuickRejectResponse>();
    expect(qr.module).toMatchObject({ id: "quick-reject", active: true, window: { from: null, to: cfg.phases.assignmentDone!.getTime() } });
    expect(qr.items.map((i) => i.pid)).toEqual([2, 3]);
    expect(qr.items.every((i) => typeof i.appealState === "string")).toBe(true);
    await api.app.close();
    store.close();
  });

  it("with PCS_DBLP_ENABLED the route queues lookups in the background and shows them once known", async () => {
    const { store, cfg } = await synced();
    const dcfg = { ...cfg, reserve: { ...cfg.reserve!, dblp: { ...cfg.reserve!.dblp, enabled: true, rps: 10 } } };
    const asked: string[] = [];
    const mock = staticLookup("DBLP (mock)", { "Cleo Ray": { venues: { ICSE: 9 }, matchedPapers: 12 } });
    const app = Fastify();
    makeRegisterModules({ dblpLookup: { label: mock.label, lookup: (n) => (asked.push(n), mock.lookup(n)) } })(app, {
      cfg: dcfg,
      store,
      clock: fixedClock(cfg.now!),
    } as unknown as RouteDeps);
    const first = (await app.inject({ method: "GET", url: "/api/reserve" })).json<ReserveResponse>();
    expect(first.dblp).toMatchObject({ enabled: true, source: "DBLP (mock)" });
    expect(first.notes.some((n) => /hints/.test(n))).toBe(true);
    await new Promise((r) => setTimeout(r, 400));
    const second = (await app.inject({ method: "GET", url: "/api/reserve" })).json<ReserveResponse>();
    expect(second.dblp).toMatchObject({ pending: 0, failed: 0, looked: 2 });
    expect(second.designees[0]!.hint).toMatchObject({ name: "Cleo Ray", atVenues: 9, possiblySenior: true });
    expect(second.designees[0]!.hint!.text).toMatch(/not a verdict/);
    expect(asked.sort()).toEqual(["Cleo Ray", "Eve Lo"]);
    await app.close();
    store.close();
  });

  it("the CLI prints counts, reasons, and searches; no titles or author notes", async () => {
    const { store, cfg } = await synced();
    const clock = fixedClock(cfg.now!);
    const cache = new HintCache(staticLookup("mock", { "Cleo Ray": { venues: { ICSE: 1 }, matchedPapers: 1 } }), { rps: 100, sleep: async () => {} });
    await cache.loadAll(["Cleo Ray", "Eve Lo"]);
    const dcfg = { ...cfg, reserve: { ...cfg.reserve!, dblp: { ...cfg.reserve!.dblp, enabled: true } } };
    const text = describeReserve(reserveReport(store, dcfg, { clock, cache })).join("\n");
    expect(text).toContain("Papers: 3 (1 with a designee, 1 exempt, 1 non-compliant); designees: 1; warnings: 0");
    expect(text).toContain('DESIGNEE_MISSING: search "2" -> Contact authors (1 papers)');
    expect(text).toMatch(/DBLP hints \(mock\): 1 shown, 2 names looked up, 0 failed, 0 pending\. Hints, never verdicts\./);
    const qtext = describeQuickReject(quickRejectReport(store, cfg, { clock })).join("\n");
    expect(qtext).toContain("Queue: 2 papers (0 awaiting AC decision, 1 awaiting chair action, 0 appeal open, 1 done)");
    expect(qtext).toContain("#3: stage done; AC reject; chair desk-reject; appeal none; decision Rejected");
    expect(qtext).toContain("#1: quinn@example.org's quick-reject review is empty, 1.5 days after PCS_PHASE_QUICKREJECT_DUE");
    for (const t of [text, qtext]) for (const title of ["One", "Two", "Three"]) expect(t).not.toContain(title);
    store.close();
  });
});
