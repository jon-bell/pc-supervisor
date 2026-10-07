// PLAN M5: golden -> sync -> rules. Proves M2 (seeder), M3 (sync + backfill)
// and M4 (rules) agree through the store -> rules adapter (views/snapshot.ts).
// The oracle is seed/scenarios/golden/expected.ts; nothing here is loosened.
//
// RESETS the harness and seeds golden. Uses a temp DB (never PCS_DB_PATH).
//
// The /reviewhistory backfill is part of the flow: at the first sync every
// review has exactly one observed version, so the day +5 / +6 score moves on
// pids 12 and 3 are only visible through HotCRP's history (spec §4). Without
// the backfill both papers would also fire UNRESOLVED_SPLIT.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedScenario } from "@pcs/seed/driver";
import { resolveWhen } from "@pcs/seed/time";
import { scenario as golden } from "@pcs/seed/scenarios/golden/scenario";
import { AT_SECOND, FIRES_AT_PRIMARY, MERITS, NOW_PRIMARY, NOW_SECOND, PEOPLE, SCORE_CHANGES } from "@pcs/seed/scenarios/golden/expected";
import { fixedClock } from "../../src/clock.js";
import { loadConfig, type Config } from "../../src/config.js";
import { clientFromConfig } from "../../src/hotcrp/client.js";
import { analyze, ruleContextFromConfig, type Analysis, type SnapshotView } from "../../src/rules/index.js";
import { openStore, type Store } from "../../src/store/store.js";
import { runBackfill } from "../../src/sync/backfill.js";
import { clientSource } from "../../src/sync/source.js";
import { runSync } from "../../src/sync/sync.js";
import { buildSnapshot } from "../../src/views/snapshot.js";

const DAY = 86_400_000;
let dir: string;
let cfg: Config;
let store: Store;
let snap: SnapshotView;
let primary: Analysis;
let second: Analysis;
let tPrimary: Date;
let tSecond: Date;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "pcs-golden-"));
  cfg = loadConfig({
    ...process.env,
    PCS_DB_PATH: join(dir, "golden.db"),
    PCS_DB_KEY: "golden-integration-key",
    PCS_TIER_TAGS: "junior=junior,reciprocal=reciprocal",
    PCS_NOW: undefined,
  });
  tPrimary = resolveWhen(NOW_PRIMARY, cfg);
  tSecond = resolveWhen(NOW_SECOND, cfg);
  // With the ci.yml dates these are the PLAN.md instants.
  expect(tPrimary.toISOString()).toBe("2030-02-26T17:00:00.000Z");
  expect(tSecond.toISOString()).toBe("2030-03-01T17:00:00.000Z");

  await seedScenario(golden, { reset: true });

  store = openStore(cfg);
  const source = clientSource(clientFromConfig(cfg.hotcrp));
  const clock = fixedClock(tPrimary);
  const s = await runSync(store.db, source, {
    clock,
    chunkSize: cfg.sync.chunk,
    concurrency: cfg.sync.concurrency,
    tierTags: cfg.tierTags,
    acRole: cfg.acRole,
  });
  expect(s.ok, s.errors.join("; ")).toBe(true);
  const b = await runBackfill(store.db, source, { clock, rps: 50 });
  expect(b.ok, b.errors.join("; ")).toBe(true);
  expect(b.remaining).toBe(0);

  snap = buildSnapshot(store, { fields: cfg.fields, acRole: cfg.acRole });
  primary = analyze(snap, ruleContextFromConfig(cfg, fixedClock(tPrimary)));
  second = analyze(snap, ruleContextFromConfig(cfg, fixedClock(tSecond)));
}, 180_000);

afterAll(() => {
  store?.close();
  rmSync(dir, { recursive: true, force: true });
});

const fired = (a: Analysis, pid: number) => a.evaluation.byPid.get(pid)!.fired.map((f) => f.rule).sort();

describe("golden -> sync -> rules at the primary instant (2030-02-26T12:00)", () => {
  it("is mid-discussion and has exactly the 12 golden papers", () => {
    expect(primary.phase).toBe("discussion");
    expect(snap.papers.map((p) => p.pid)).toEqual(Object.keys(FIRES_AT_PRIMARY).map(Number));
  });

  for (const [pid, rules] of Object.entries(FIRES_AT_PRIMARY)) {
    it(`pid ${pid} fires exactly ${rules.length ? rules.join(", ") : "nothing"}`, () => {
      expect(fired(primary, Number(pid))).toEqual([...rules].sort());
    });
  }

  it("the synced merits match the scenario", () => {
    const acs = new Set(snap.acs.map((a) => `${a.pid}:${a.email}`));
    for (const [pid, merits] of Object.entries(MERITS)) {
      const got = snap.reviews
        .filter((r) => r.pid === Number(pid) && r.rtype !== 5 && !acs.has(`${r.pid}:${r.email}`) && r.status === "complete")
        .map((r) => r.merit)
        .sort();
      expect(got, `pid ${pid}`).toEqual(merits);
    }
  });

  it("score movement comes through review_version (history backfill + snapshot)", () => {
    for (const c of SCORE_CHANGES) {
      const r = snap.reviews.find((x) => x.pid === c.pid && x.email === c.email)!;
      const scored = r.versions.filter((v) => v.merit !== null);
      expect(scored.map((v) => v.merit)).toEqual([c.from, c.to]);
      const expectedAt = resolveWhen({ phase: "discussionOpen", day: c.day, time: "12:00" }, cfg).getTime();
      expect(Math.abs(scored[1]!.seenAt - expectedAt)).toBeLessThanOrEqual(60_000);
    }
  });

  it("orders triage by severity, then pid", () => {
    expect(primary.evaluation.results.map((r) => [r.pid, r.severity])).toEqual([
      [5, 7],
      [4, 5],
      [2, 3],
      [3, 3],
      [12, 3],
      [6, 2],
      [7, 2],
      [9, 2],
      [11, 2],
      [8, 1],
      [10, 1],
      [1, 0],
    ]);
  });
});

describe("golden at the second instant (2030-03-01T12:00)", () => {
  it("pid 12 includes DEADLINE_NO_CONSENSUS and pid 1 fires nothing", () => {
    expect(second.phase).toBe("discussion");
    for (const [pid, rules] of Object.entries(AT_SECOND.includes)) {
      expect(fired(second, Number(pid))).toEqual(expect.arrayContaining([...rules]));
    }
    for (const [pid, rules] of Object.entries(AT_SECOND.exactly)) {
      expect(fired(second, Number(pid))).toEqual([...rules].sort());
    }
  });
});

describe("golden people facts", () => {
  const rev = (email: string) => primary.reviewers.find((r) => r.email === email)!;
  const ac = (email: string) => primary.acs.find((x) => x.email === email)!;

  it("R-silent tops silent-on-split with 3 papers and is junior", () => {
    const s = PEOPLE.silentOnSplit;
    for (const [email, pids] of Object.entries(s)) expect(rev(email).silentOnSplit, email).toEqual(pids);
    const silent = Object.entries(s).find(([, pids]) => pids.length === 3)![0];
    expect(rev(silent).tier).toBe("junior");
    expect(PEOPLE.tiers.junior).toEqual([silent]);
    const all = Object.values(primary.outliers.silentOnSplit).flat();
    expect(all.filter((e) => e.count === Math.max(...all.map((x) => x.count))).map((e) => e.email)).toEqual([silent]);
  });

  it("R-pinged has an unanswered @mention ping of 11+ days on pid 4", () => {
    for (const p of PEOPLE.unansweredPings) {
      const u = rev(p.email).responsiveness.unanswered;
      expect(u.map((x) => x.pid)).toEqual([p.pid]);
      const mentionedAt = resolveWhen({ phase: "discussionOpen", day: p.day, time: "09:00" }, cfg).getTime();
      expect(Math.abs(u[0]!.mentionedAt! - mentionedAt)).toBeLessThanOrEqual(60_000);
      expect((tPrimary.getTime() - u[0]!.mentionedAt!) / DAY).toBeGreaterThanOrEqual(11);
      const c = snap.comments.find((x) => x.pid === p.pid && x.email === p.by && x.mentions.includes(p.email));
      expect(c).toBeDefined();
    }
  });

  it("AC-busy, AC-idle, AC-normal: papers, flags, comments", () => {
    for (const [email, want] of Object.entries(PEOPLE.acs)) {
      const m = ac(email);
      expect(m.pids, want.label).toEqual(want.pids);
      expect(m.flaggedPids, want.label).toEqual(want.flagged);
      expect(m.load).toBe(want.pids.length);
      if ("commentsOnAll" in want) expect(m.coverage).toEqual({ covered: want.pids.length, of: want.pids.length, share: 1 });
      if ("comments" in want) {
        expect(m.discussionComments).toBe(want.comments);
        expect(snap.comments.filter((c) => c.email === email)).toHaveLength(0);
      }
    }
    expect(ac(Object.keys(PEOPLE.acs)[1]!).load).toBeLessThan(ac(Object.keys(PEOPLE.acs)[0]!).load);
  });

  it("the reciprocal laggard on pid 2 is late, with the review outstanding", () => {
    const r = rev(PEOPLE.laggard.email);
    expect(r.tier).toBe("reciprocal");
    expect(PEOPLE.tiers.reciprocal).toEqual([PEOPLE.laggard.email]);
    expect(r.late).toBe(true);
    expect(r.outstanding).toEqual([PEOPLE.laggard.pid]);
  });

  it("everyone else is senior", () => {
    const special = new Set<string>([...PEOPLE.tiers.junior, ...PEOPLE.tiers.reciprocal]);
    const tiers = new Set(primary.reviewers.filter((r) => !special.has(r.email)).map((r) => r.tier));
    expect([...tiers]).toEqual(["senior"]);
  });

  it("the response on pid 11 and the decision on pid 1 come through", () => {
    const resp = snap.comments.filter((c) => c.isResponse);
    expect(resp.map((c) => [c.pid, c.email])).toEqual([[PEOPLE.response.pid, PEOPLE.response.email]]);
    const p1 = snap.papers.find((p) => p.pid === PEOPLE.decided.pid)!;
    expect(p1.decision).toBe(PEOPLE.decided.decision);
    // HotCRP has no decision timestamp: the first sync's time stands in.
    expect(p1.decisionSeenAt).toBe(tPrimary.getTime());
  });
});
