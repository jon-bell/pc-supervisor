// PLAN M3 acceptance on M2's `multistage` scenario (seed/README.md lists both
// stages exactly): stage 1 -> sync @STAGE1_NOW -> stage 2 -> sync
// @STAGE2_NOW -> exactly the expected review_version, first_seen_at and
// deletion rows. Then the store -> rules adapter's view of the result.
//
// RESETS the harness. Temp DB (never PCS_DB_PATH).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedScenario } from "@pcs/seed/driver";
import { resolveWhen } from "@pcs/seed/time";
import { M, scenario, STAGE1_NOW, STAGE2_NOW } from "@pcs/seed/scenarios/multistage/scenario";
import { fixedClock } from "../../src/clock.js";
import { loadConfig, type Config } from "../../src/config.js";
import { clientFromConfig } from "../../src/hotcrp/client.js";
import { openStore, type Store } from "../../src/store/store.js";
import { clientSource, type SyncSource } from "../../src/sync/source.js";
import { runSync, type SyncResult } from "../../src/sync/sync.js";
import { buildSnapshot } from "../../src/views/snapshot.js";

let dir: string;
let cfg: Config;
let store: Store;
let source: SyncSource;
let t1: number; // epoch s
let t2: number;
let run1: SyncResult;
let run2: SyncResult;
/** Scenario comment key -> cid, from the stage-1/2 syncs (unique by pid + author). */
const cid: Record<string, number> = {};
const sec = (d: Date) => Math.floor(d.getTime() / 1000);
const d = (day: number, time: string) => sec(resolveWhen({ phase: "discussionOpen", day, time }, cfg));
const sub = (day: number) => sec(resolveWhen({ phase: "reviewDue", day, time: "10:00" }, cfg));

async function sync(at: number): Promise<SyncResult> {
  const r = await runSync(store.db, source, {
    clock: fixedClock(new Date(at * 1000)),
    chunkSize: cfg.sync.chunk,
    concurrency: cfg.sync.concurrency,
    tierTags: cfg.tierTags,
    acRole: cfg.acRole,
  });
  expect(r.ok, r.errors.join("; ")).toBe(true);
  return r;
}

const cidOf = (pid: number, email: string) => {
  const rows = store.comments({ pids: [pid], includeGone: true }).filter((c) => c.email === email);
  return rows.map((c) => c.cid);
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "pcs-multistage-"));
  cfg = loadConfig({
    ...process.env,
    PCS_DB_PATH: join(dir, "ms.db"),
    PCS_DB_KEY: "multistage-integration-key",
    PCS_TIER_TAGS: "junior=junior,reciprocal=reciprocal",
    PCS_NOW: undefined,
  });
  t1 = sec(resolveWhen(STAGE1_NOW, cfg));
  t2 = sec(resolveWhen(STAGE2_NOW, cfg));
  store = openStore(cfg);
  source = clientSource(clientFromConfig(cfg.hotcrp));

  await seedScenario(scenario, { stage: 1, reset: true });
  run1 = await sync(t1);
  [cid.c1] = cidOf(1, M.ac);
  [cid.c2] = cidOf(1, M.ana);
  [cid.c3] = cidOf(2, M.ac);
  [cid.c4] = cidOf(2, M.bo);
  [cid.c5] = cidOf(3, M.cy);

  await seedScenario(scenario, { stage: 2 });
  run2 = await sync(t2);
  [cid.c6] = cidOf(1, M.bo);
  [cid.c7] = cidOf(3, M.ac);
}, 180_000);

afterAll(() => {
  store?.close();
  rmSync(dir, { recursive: true, force: true });
});

const rows = <T>(sql: string, ...args: unknown[]) => store.db.prepare(sql).all(...args) as T[];

describe("multistage: stage 1 sync", () => {
  it("sees 13 review rows and 5 comments, all approximate first-seen = modified_at", () => {
    // (Asserted after stage 2 too, so count what stage 1's sync wrote.)
    expect(rows("select rid from review where first_seen_at <= ?", t1)).toHaveLength(13);
    expect(store.reviews({ includeGone: true })).toHaveLength(13);
    expect(Object.values(cid).slice(0, 5).every((c) => typeof c === "number")).toBe(true);
    const c1 = rows<{ cid: number; first_seen_at: number; first_seen_approx: number; modified_at: number; sync_run_id: number }>(
      "select c.cid, c.first_seen_at, c.first_seen_approx, t.modified_at, t.sync_run_id from comment c join comment_text t on t.cid = c.cid where t.sync_run_id = ? order by c.cid",
      run1.runId,
    );
    expect(c1.map((r) => r.cid)).toEqual([cid.c1, cid.c2, cid.c3, cid.c4, cid.c5].sort((a, b) => a! - b!));
    for (const r of c1) expect([r.first_seen_approx, r.first_seen_at]).toEqual([1, r.modified_at]);
    expect(store.comments().find((c) => c.cid === cid.c1)!.mentions).toEqual([M.ana]);
    expect(store.comments().find((c) => c.cid === cid.c1)!.firstSeenAt).toBe(d(1, "09:00"));
    expect(store.comments({ includeGone: true }).find((c) => c.cid === cid.c5)!.firstSeenAt).toBe(d(2, "16:00"));
  });

  it("records one snapshot version per review, seen at stage 1", () => {
    const v = rows<{ n: number; seen: number }>("select count(*) as n, count(distinct seen_at) as seen from review_version where sync_run_id = ?", run1.runId);
    expect(v[0]).toEqual({ n: 13, seen: 1 });
    expect(rows<{ s: number }>("select distinct seen_at as s from review_version where sync_run_id = ?", run1.runId)).toEqual([{ s: t1 }]);
  });
});

describe("multistage: stage 2 sync, exactly the expected diff rows", () => {
  it("review_version: only ms-ana's merit change on pid 1", () => {
    const v = rows<{ pid: number; email: string; seen_at: number; source: string; modified_at: number; merit: number }>(
      `select r.pid, r.email, v.seen_at, v.source, v.modified_at, json_extract(v.scores, '$.OveMer') as merit
         from review_version v join review r on r.rid = v.rid where v.sync_run_id = ?`,
      run2.runId,
    );
    expect(v).toEqual([{ pid: 1, email: M.ana, seen_at: t2, source: "snapshot", modified_at: d(4, "10:00"), merit: 3 }]);
  });

  it("first_seen_at: only ms-c6 and ms-c7 are new at stage 2 (not approximate); no new reviews", () => {
    const fresh = rows<{ cid: number; first_seen_approx: number }>(
      "select cid, first_seen_approx from comment where first_seen_at = ? order by cid",
      t2,
    );
    expect(fresh).toEqual([cid.c6, cid.c7].sort((a, b) => a! - b!).map((c) => ({ cid: c, first_seen_approx: 0 })));
    expect(rows("select rid from review where first_seen_at = ?", t2)).toEqual([]);
    expect(store.comments().find((c) => c.cid === cid.c6)!.mentions).toEqual([M.ana]);
  });

  it("comment_text: the edit of ms-c2 plus the two new comments", () => {
    const t = rows<{ cid: number; modified_at: number }>(
      "select cid, modified_at from comment_text where sync_run_id = ? order by cid",
      run2.runId,
    );
    expect(t.map((r) => r.cid)).toEqual([cid.c2, cid.c6, cid.c7].sort((a, b) => a! - b!));
    expect(t.find((r) => r.cid === cid.c2)!.modified_at).toBe(d(5, "09:00"));
    expect(store.commentHistory(cid.c2!)).toHaveLength(2);
    // The rewrite has no mention.
    expect(store.comments().find((c) => c.cid === cid.c2)!.mentions).toEqual([]);
  });

  it("deletions: ms-c5, ms-dee's review on pid 2 and its assignment; nothing else", () => {
    expect(rows("select cid, deleted_seen_at as at from comment where deleted_seen_at is not null")).toEqual([{ cid: cid.c5, at: t2 }]);
    expect(rows("select pid, email, deleted_seen_at as at from review where deleted_seen_at is not null")).toEqual([
      { pid: 2, email: M.dee, at: t2 },
    ]);
    expect(rows("select pid, email, role, removed_seen_at as at from assignment where removed_seen_at is not null")).toEqual([
      { pid: 2, email: M.dee, role: "pc", at: t2 },
    ]);
    expect(rows("select pid from paper where deleted_seen_at is not null")).toEqual([]);
    expect(rows("select email from person where removed_seen_at is not null")).toEqual([]);
    expect(store.reviews()).toHaveLength(12);
    expect(store.comments().map((c) => c.cid).sort((a, b) => a - b)).toEqual(
      [cid.c1, cid.c2, cid.c3, cid.c4, cid.c6, cid.c7].sort((a, b) => a! - b!),
    );
  });
});

describe("multistage: the rules adapter's view after stage 2", () => {
  it("versions, earliest comment times, mentions, tiers", () => {
    const s = buildSnapshot(store, { fields: cfg.fields, acRole: cfg.acRole });
    const ana1 = s.reviews.find((r) => r.pid === 1 && r.email === M.ana)!;
    expect(ana1.merit).toBe(3);
    expect(ana1.versions.map((v) => [v.merit, v.seenAt / 1000])).toEqual([
      [2, sub(-5)],
      [3, d(4, "10:00")],
    ]);
    // The edited comment keeps its original time; deleted ones are gone; deleted review too.
    const c2 = s.comments.find((c) => c.cid === cid.c2)!;
    expect([c2.time / 1000, c2.approximate, c2.mentions]).toEqual([d(2, "10:00"), true, []]);
    const c6 = s.comments.find((c) => c.cid === cid.c6)!;
    expect([c6.time / 1000, c6.approximate, c6.mentions]).toEqual([d(4, "14:00"), false, [M.ana]]);
    expect(s.comments.some((c) => c.cid === cid.c5)).toBe(false);
    expect(s.reviews.some((r) => r.pid === 2 && r.email === M.dee)).toBe(false);
    expect(s.acs.filter((a) => a.email === M.ac).map((a) => a.pid)).toEqual([1, 2, 3]);
    const tier = Object.fromEntries(s.people.filter((p) => p.email.startsWith("ms-")).map((p) => [p.email, p.tier]));
    expect(tier[M.ana]).toBe("junior");
    expect(tier[M.dee]).toBe("reciprocal");
    expect(tier[M.bo]).toBe("senior");
  });
});
