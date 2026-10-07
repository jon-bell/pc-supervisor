// PLAN M3 acceptance against the harness:
//   (a) seed a small scenario -> sync -> DB matches expectations
//   (b) multi-stage: stage 1 -> sync @t1 -> stage 2 (score change, new
//       comment, edited comment, deleted comment, unassigned review) ->
//       sync @t2 -> exactly the expected review_version, first_seen_at, and
//       deletion rows
//   (c) idempotent re-sync = zero new rows
//   (d) opening the DB with the wrong key fails
// The steps share one DB and run in order. Isolation: fresh pids above all
// existing papers and run-unique users (MiniSeed), so other suites' data in
// the harness never matches our assertions.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixedClock } from "../../src/clock.js";
import { loadHotcrpConfig } from "../../src/config.js";
import { clientFromConfig } from "../../src/hotcrp/client.js";
import { openDb, StoreError } from "../../src/store/db.js";
import { openStore, type Store } from "../../src/store/store.js";
import { clientSource, type SyncSource } from "../../src/sync/source.js";
import { runBackfill } from "../../src/sync/backfill.js";
import { runSync, type SyncOptions, type SyncResult } from "../../src/sync/sync.js";
import { MiniSeed } from "../support/mini-seed.js";

const T1 = new Date("2030-02-14T12:00:00Z");
const T2 = new Date("2030-02-18T12:00:00Z");
const T3 = new Date("2030-02-19T12:00:00Z");
const s = (d: Date) => d.getTime() / 1000;
const KEY = "integration-test-key";

const TABLES = ["person", "paper", "assignment", "review", "review_version", "review_text", "comment", "comment_text", "comment_mention", "review_field"];

let seed: MiniSeed;
let dir: string;
let dbPath: string;
let store: Store;
let source: SyncSource;
let P: number; // first pid
let Q: number; // second pid
const cid: Record<string, number> = {};
const rid: Record<string, number> = {};
const timings: Record<string, number> = {};

function opts(at: Date): SyncOptions {
  return {
    clock: fixedClock(at),
    chunkSize: 25,
    concurrency: 2,
    tierTags: { junior: `jr${seed.run}`, reciprocal: `rc${seed.run}` },
    acRole: { kind: "meta" },
  };
}

function rowCounts(): Record<string, number> {
  return Object.fromEntries(TABLES.map((t) => [t, (store.db.prepare(`select count(*) as n from ${t}`).get() as { n: number }).n]));
}

async function sync(at: Date, label: string): Promise<SyncResult> {
  const r = await runSync(store.db, source, opts(at));
  expect(r.ok, r.errors.join("; ")).toBe(true);
  timings[label] = r.durationMs;
  return r;
}

beforeAll(async () => {
  seed = new MiniSeed();
  dir = mkdtempSync(join(tmpdir(), "pcs-m3-int-"));
  dbPath = join(dir, "pcs.db");
  store = openStore({ db: { path: dbPath, key: KEY } });
  source = clientSource(clientFromConfig(loadHotcrpConfig(process.env), { chunkSize: 25 }));

  // ---- stage 1 -----------------------------------------------------------
  seed.openReviewing();
  const R = seed.run;
  seed.saveUsers([
    { key: "ac", first: "Ada", last: `Chair${R}` },
    { key: "r1", first: "Rhea", last: `Junior${R}`, tags: [`jr${R}`] },
    { key: "r2", first: "Remy", last: `Senior${R}` },
    { key: "r3", first: "Rosa", last: `Recip${R}`, tags: [`rc${R}`] },
  ]);
  P = await seed.nextPid();
  Q = P + 1;
  seed.savePapers([
    { pid: P, title: `M3 integration paper A ${R}` },
    { pid: Q, title: `M3 integration paper B ${R}` },
  ]);
  seed.assign([
    [P, "metareview", "ac"],
    [P, "primary", "r1"],
    [P, "primary", "r2"],
    [P, "lead", "ac"],
    [Q, "metareview", "ac"],
    [Q, "primary", "r2"],
    [Q, "primary", "r3"],
    [Q, "manager", "r2"],
  ]);
  seed.tagPapers([[P, `hot${R}`]]);
  rid.r1P = await seed.submitReview(P, "r1", { OveMer: 2, RevExp: 3, PapSum: "The evaluation is thin.", ComAut: "Please add baselines and ablations." });
  rid.r2P = await seed.submitReview(P, "r2", { OveMer: 4, RevExp: 4, PapSum: "Interesting work.", ComAut: "Accept with minor revisions." });
  rid.r2Q = await seed.submitReview(Q, "r2", { OveMer: 3, RevExp: 2, PapSum: "Okay.", ComAut: "Borderline." });
  rid.r3Q = await seed.rid(Q, "r3"); // stays empty; unassigned in stage 2
  rid.acP = await seed.rid(P, "ac");
  await seed.rate(P, rid.r1P, "r2", "short");
  seed.backdateRequests([P, Q]);
  cid.ping = await seed.comment(P, "ac", `@Rhea Junior${R} could you expand on the evaluation concerns?`);
  cid.edit = await seed.comment(P, "r2", "I am fairly positive.");
  cid.del = await seed.comment(Q, "ac", `@${seed.email("r2")} thoughts?`);
}, 120_000);

afterAll(() => {
  store?.close();
  rmSync(dir, { recursive: true, force: true });
  // Timing, for the M3 report. Counts only.
  console.log(`M3 integration sync timings (ms): ${JSON.stringify(timings)}`);
});

describe("M3 store + sync against the harness", () => {
  it("(a) first sync: the DB matches the seeded scenario", async () => {
    const r = await sync(T1, "first");
    expect(r.counts.reviews_new).toBeGreaterThanOrEqual(6);

    const papers = store.papers({ pids: [P, Q] });
    expect(papers.map((p) => p.pid)).toEqual([P, Q]);
    expect(papers[0]).toMatchObject({ status: "Submitted", decision: null, tags: [`hot${seed.run}`], lead: seed.email("ac") });
    expect(papers[1]).toMatchObject({ manager: seed.email("r2"), lead: null });

    const people = Object.fromEntries(store.people().map((p) => [p.email, p]));
    expect(people[seed.email("r1")]).toMatchObject({ isPc: true, tier: "junior", name: `Rhea Junior${seed.run}` });
    expect(people[seed.email("r3")]).toMatchObject({ tier: "reciprocal" });
    expect(people[seed.email("r2")]).toMatchObject({ tier: "senior" });

    const asg = store.assignments({ pids: [P] }).map((a) => `${a.role} ${a.email}`);
    expect(asg).toEqual([`lead ${seed.email("ac")}`, `meta ${seed.email("ac")}`, `primary ${seed.email("r1")}`, `primary ${seed.email("r2")}`]);
    expect(store.areaChairs({ kind: "meta" }, { pids: [P, Q] })).toEqual([
      { pid: P, email: seed.email("ac") },
      { pid: Q, email: seed.email("ac") },
    ]);

    const reviews = Object.fromEntries(store.reviews({ pids: [P, Q] }).map((x) => [x.rid, x]));
    expect(Object.keys(reviews)).toHaveLength(6);
    expect(reviews[rid.r1P!]).toMatchObject({
      email: seed.email("r1"),
      rtype: 4,
      complete: true,
      scores: expect.objectContaining({ OveMer: 2, RevExp: 3 }),
      wordCount: 4 + 5,
      ratings: ["short"],
      firstSeenApprox: true,
    });
    // Present at the first sync: first_seen_at is HotCRP's modified_at.
    expect(reviews[rid.r1P!]!.firstSeenAt).toBe(reviews[rid.r1P!]!.modifiedAt);
    expect(reviews[rid.r3Q!]).toMatchObject({ complete: false, firstCompleteSeenAt: null });
    expect(store.reviewText(rid.r1P!)).toMatchObject({ PapSum: "The evaluation is thin.\n" });
    expect(store.reviewsWithHistory({ pids: [P] }).find((x) => x.rid === rid.r1P)!.versions).toHaveLength(1);

    const comments = Object.fromEntries(store.comments({ pids: [P, Q] }).map((c) => [c.cid, c]));
    expect(Object.keys(comments)).toHaveLength(3);
    expect(comments[cid.ping!]).toMatchObject({ email: seed.email("ac"), mentions: [seed.email("r1")], firstSeenApprox: true });
    expect(comments[cid.del!]!.mentions).toEqual([seed.email("r2")]);
    expect(comments[cid.edit!]).toMatchObject({ mentions: [], wordCount: 4 });

    expect(store.searchText("ablations").map((h) => h.rid)).toContain(rid.r1P);
    expect(store.lastSuccessfulSync()).toMatchObject({ id: r.runId, nowUsed: s(T1) });
  });

  it("(b) stage 2 -> sync @t2: exactly the expected versions, first-seen, and deletions", async () => {
    // ---- stage 2 ----
    await seed.submitReview(P, "r1", { OveMer: 3, RevExp: 3, PapSum: "The evaluation is thin.", ComAut: "Please add baselines and ablations." });
    cid.fresh = await seed.comment(P, "r1", "Fair point; I raised my score after the discussion.");
    await seed.editComment(P, cid.edit!, "r2", `I am fairly positive. @Ada Chair${seed.run} do you agree?`);
    await seed.deleteComment(Q, cid.del!);
    seed.assign([[Q, "clearreview", "r3"]]);

    const r = await sync(T2, "second");
    const ours = { rids: Object.values(rid), cids: Object.values(cid) };

    // review_version: one new row, for r1's score change, seen at t2.
    const versions = store.db
      .prepare(`select rid, seen_at, source, scores from review_version where sync_run_id = ? and rid in (select value from json_each(?))`)
      .all(r.runId, JSON.stringify(ours.rids)) as { rid: number; seen_at: number; source: string; scores: string }[];
    expect(versions.map((v) => [v.rid, v.seen_at, v.source, JSON.parse(v.scores).OveMer])).toEqual([[rid.r1P, s(T2), "snapshot", 3]]);
    const h = store.reviewsWithHistory({ pids: [P] }).find((x) => x.rid === rid.r1P)!;
    expect(h.versions.map((v) => v.scores.OveMer)).toEqual([2, 3]);
    expect(h.scores.OveMer).toBe(3);

    // first_seen_at: only the new comment is new at t2, and not approximate.
    const newAtT2 = store.db
      .prepare(`select cid from comment where first_seen_at = ? and pid in (?, ?)`)
      .all(s(T2), P, Q) as { cid: number }[];
    expect(newAtT2.map((x) => x.cid)).toEqual([cid.fresh]);
    expect(store.comments({ pids: [P] }).find((c) => c.cid === cid.fresh)).toMatchObject({ firstSeenApprox: false, email: seed.email("r1") });
    expect(store.db.prepare(`select count(*) as n from review where first_seen_at = ? and pid in (?, ?)`).get(s(T2), P, Q)).toEqual({ n: 0 });

    // comment_text: the edit and the new comment.
    const texts = store.db
      .prepare(`select cid from comment_text where sync_run_id = ? and cid in (select value from json_each(?)) order by cid`)
      .all(r.runId, JSON.stringify(ours.cids)) as { cid: number }[];
    expect(texts.map((t) => t.cid)).toEqual([cid.edit, cid.fresh].sort((a, b) => a! - b!));
    expect(store.commentHistory(cid.edit!)).toHaveLength(2);
    expect(store.comments().find((c) => c.cid === cid.edit)!.mentions).toEqual([seed.email("ac")]);

    // Deletions: the deleted comment, the unassigned review and its assignment. Nothing else of ours.
    const goneComments = store.comments({ pids: [P, Q], includeGone: true }).filter((c) => c.deletedSeenAt !== null);
    expect(goneComments.map((c) => [c.cid, c.deletedSeenAt])).toEqual([[cid.del, s(T2)]]);
    const goneReviews = store.reviews({ pids: [P, Q], includeGone: true }).filter((x) => x.deletedSeenAt !== null);
    expect(goneReviews.map((x) => [x.rid, x.deletedSeenAt])).toEqual([[rid.r3Q, s(T2)]]);
    const goneAsg = store.assignments({ pids: [P, Q], includeGone: true }).filter((a) => a.removedSeenAt !== null);
    expect(goneAsg.map((a) => [a.pid, a.email, a.role, a.removedSeenAt])).toEqual([[Q, seed.email("r3"), "primary", s(T2)]]);
    // Rows are kept.
    expect(store.commentText(cid.del!)).toMatch(/thoughts\?/);
  });

  it("(c) an unchanged re-sync writes zero new rows", async () => {
    const before = rowCounts();
    const r = await sync(T3, "unchanged");
    expect(rowCounts()).toEqual(before);
    const changes = Object.entries(r.counts).filter(([k]) => !["reviews_fetched", "comments_fetched", "paper_details_fetched", "tag_queries"].includes(k));
    expect(changes).toEqual([]);
  });

  it("backfill: /reviewhistory adds older versions as source=history", async () => {
    const r = await runBackfill(store.db, source, { clock: fixedClock(T3), rps: 50 });
    expect(r.ok, r.errors.join("; ")).toBe(true);
    expect(r.remaining).toBe(0);
    const h = store.reviewsWithHistory({ pids: [P] }).find((x) => x.rid === rid.r1P)!;
    // empty (assignment) -> merit 2 (from history or snapshot) -> merit 3
    expect(h.versions.map((v) => [v.source, v.status, v.scores.OveMer ?? null])).toEqual([
      ["history", "empty", null],
      ["snapshot", "complete", 2],
      ["snapshot", "complete", 3],
    ]);
    const again = await runBackfill(store.db, source, { clock: fixedClock(T3), rps: 50 });
    expect(again).toMatchObject({ done: 0, versionsNew: 0 });
  });

  it("(d) opening the DB with the wrong key fails clearly", () => {
    store.close();
    expect(() => openDb(dbPath, { key: "not-the-key" })).toThrow(StoreError);
    expect(() => openDb(dbPath, { key: "not-the-key" })).toThrow(/wrong PCS_DB_KEY/);
    store = openStore({ db: { path: dbPath, key: KEY } });
    expect(store.papers({ pids: [P] })).toHaveLength(1);
  });
});
