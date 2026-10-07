// PLAN M12 acceptance on the local harness: seed `earlyreject` stage 1 (after
// a reset), sync at window open, compute the early-reject candidates and the
// tier-progress outputs; seed stage 2, sync at window close, and check the
// bumped / not-bumped / no-response lists and the tier-progress outputs
// against expected.ts. Also: the reports at an instant before and during the
// window, and that HotCRP's search for the drafted mail-tool query returns
// exactly the candidates (a read).
//
// RESETS the harness. Temp DB (never PCS_DB_PATH). The window comes from
// earlyRejectEnv(), relative to the ci.yml phase dates.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixedClock } from "@pcs/server/clock";
import { loadConfig, type Config } from "@pcs/server/config";
import { clientFromConfig } from "@pcs/server/hotcrp/client";
import { earlyReject, type EarlyRejectReport } from "@pcs/server/modules/early-reject/index";
import { tierProgress, type TierProgressReport } from "@pcs/server/modules/tier-progress/index";
import { openStore, type Store } from "@pcs/server/store/store";
import { clientSource } from "@pcs/server/sync/source";
import { runSync } from "@pcs/server/sync/sync";
import { seedContextFromEnv, seedScenario } from "../../src/driver.js";
import { at } from "../../src/format.js";
import { resolveWhen } from "../../src/time.js";
import { verifyScenario } from "../../src/verify.js";
import * as X from "../../scenarios/earlyreject/expected.js";
import { CLOSE_AT, E, OPEN_AT, earlyRejectEnv, scenario } from "../../scenarios/earlyreject/scenario.js";

const sc = seedContextFromEnv();
const env = earlyRejectEnv(sc.ctx);
const open = resolveWhen(OPEN_AT, sc.ctx);
const close = resolveWhen(CLOSE_AT, sc.ctx);
let dir: string;
let cfg: Config;
let store: Store;
let stage1Problems: string[];
const R: {
  tpOpen?: TierProgressReport;
  erOpen?: EarlyRejectReport;
  erOpenStrict?: EarlyRejectReport;
  erBefore?: EarlyRejectReport;
  tpClose?: TierProgressReport;
  erClose?: EarlyRejectReport;
  erDuring?: EarlyRejectReport;
} = {};

const key = (x: { person: { email: string }; pid: number }) => `${x.person.email}@${x.pid}`;

async function sync(t: Date) {
  const r = await runSync(store.db, clientSource(clientFromConfig(cfg.hotcrp)), {
    clock: fixedClock(t),
    chunkSize: cfg.sync.chunk,
    concurrency: cfg.sync.concurrency,
    tierTags: cfg.tierTags,
    acRole: cfg.acRole,
  });
  expect(r.ok, r.errors.join("; ")).toBe(true);
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "pcs-m12-int-"));
  const base = { ...process.env, ...env, PCS_DB_PATH: join(dir, "pcs.db"), PCS_DB_KEY: "m12-integration-key", PCS_NOW: undefined };
  cfg = loadConfig(base);
  const strict = loadConfig({ ...base, PCS_POLICY_EARLYREJECT: "reject_only" });
  store = openStore(cfg);

  await seedScenario(scenario, { stage: 1, reset: true });
  stage1Problems = (await verifyScenario(scenario, sc.ctx, 1)).problems;
  await sync(open);
  R.tpOpen = tierProgress(store, cfg, fixedClock(open));
  R.erOpen = earlyReject(store, cfg, fixedClock(open));
  R.erOpenStrict = earlyReject(store, strict, fixedClock(open));
  R.erBefore = earlyReject(store, cfg, fixedClock(resolveWhen(at("reviewDue", 1, "12:00"), sc.ctx)));

  await seedScenario(scenario, { stage: 2 });
  await sync(close);
  R.tpClose = tierProgress(store, cfg, fixedClock(close));
  R.erClose = earlyReject(store, cfg, fixedClock(close));
  R.erDuring = earlyReject(store, cfg, fixedClock(resolveWhen(at("reviewDue", 3, "10:30"), sc.ctx)));
}, 240_000);

afterAll(() => {
  store?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("earlyreject scenario: seeding", () => {
  it("both stages are in the harness exactly (the stage-2 assignment included)", async () => {
    expect(stage1Problems).toEqual([]);
    expect((await verifyScenario(scenario, sc.ctx, 2)).problems).toEqual([]);
  });

  it("the window env is consistent with the ci.yml phase dates", () => {
    expect(cfg.phases.earlyRejectOpen!.getTime()).toBe(open.getTime());
    expect(cfg.phases.earlyRejectClose!.getTime()).toBe(close.getTime());
    expect(open > cfg.phases.reviewDue && close < (cfg.phases.responseOpen ?? cfg.phases.discussionOpen)).toBe(true);
  });
});

describe("early reject", () => {
  it("before the window: provisional candidates, no outcomes", () => {
    const r = R.erBefore!;
    expect(r.status).toBe("before");
    expect(r.candidates.map((c) => c.pid)).toEqual(X.CANDIDATES.include_weak_reject);
    expect([r.bumped, r.notBumped, r.noResponse]).toEqual([[], [], []]);
  });

  it("at window open: the candidates, per policy, with their merits", () => {
    const r = R.erOpen!;
    expect(r.status).toBe("open");
    expect(r.candidatesAt).toBe(open.getTime());
    expect(r.syncAtOpen).toBe(open.getTime());
    expect(r.candidates.map((c) => c.pid)).toEqual(X.CANDIDATES.include_weak_reject);
    for (const c of r.candidates) expect([...c.meritsAtOpen].sort()).toEqual(X.MERITS_AT_OPEN[c.pid]);
    expect(R.erOpenStrict!.candidates.map((c) => c.pid)).toEqual(X.CANDIDATES.reject_only);
    expect(r.candidates.every((c) => /merits [\d/]+ as of window open/.test(c.reason))).toBe(true);
  });

  it("the drafted mail-tool search finds exactly the candidates in HotCRP", async () => {
    const r = R.erOpen!;
    expect(r.mail!.search).toBe("1 2 3");
    expect(r.mail!.body).toContain(`within ${cfg.earlyReject!.windowHours} hours`);
    const res = await clientFromConfig(cfg.hotcrp).search({ q: r.mail!.search });
    expect([...res.ids].sort((a, b) => a - b)).toEqual(X.CANDIDATES.include_weak_reject);
  });

  it("during the window: outcomes so far", () => {
    const r = R.erDuring!;
    expect(r.status).toBe("open");
    expect(r.candidates.map((c) => c.pid)).toEqual(X.CANDIDATES.include_weak_reject);
    expect(r.bumped).toEqual([1]);
    // At +3 d 10:30, s5 (#3, lowers at 11:00) and j2 (#3, comments at 12:00) have not responded yet; j1 just has.
    expect(r.noResponse.map(key).sort()).toEqual([...X.AT_CLOSE.noResponse, `${E.s5}@3`, `${E.j2}@3`].sort());
  });

  it("at window close: candidates as of open; bumped, not bumped, and no response exactly", () => {
    const r = R.erClose!;
    expect(r.status).toBe("open"); // the close instant belongs to the window
    expect(r.outcomeAt).toBe(close.getTime());
    expect(r.candidates.map((c) => c.pid)).toEqual(X.CANDIDATES.include_weak_reject);
    expect(r.candidates.map((c) => c.meritsAtOpen)).toEqual(R.erOpen!.candidates.map((c) => c.meritsAtOpen));
    expect(r.bumped).toEqual(X.AT_CLOSE.bumped);
    expect(r.notBumped).toEqual(X.AT_CLOSE.notBumped);
    expect(r.noResponse.map(key).sort()).toEqual(X.AT_CLOSE.noResponse);
    for (const c of r.candidates) expect(c.stillInBand).toBe(X.AT_CLOSE.stillInBand[c.pid]);
    const p1 = r.candidates.find((c) => c.pid === 1)!;
    expect(p1.signals).toMatchObject({ comments: 2, windowComments: 1, acComments: 0 });
    expect(p1.reason).toMatch(/1 raised \(1->3\)/);
  });

  it("after close, the same report (nothing after CLOSE counts)", () => {
    const later = earlyReject(store, cfg, fixedClock(resolveWhen(at("reviewDue", 5, "12:00"), sc.ctx)));
    expect(later.status).toBe("closed");
    expect([later.bumped, later.notBumped, later.noResponse.map(key).sort()]).toEqual([X.AT_CLOSE.bumped, X.AT_CLOSE.notBumped, X.AT_CLOSE.noResponse]);
  });
});

describe("reviewing progress by tier", () => {
  const counts = (r: TierProgressReport) =>
    Object.fromEntries(
      r.tiers.map((t) => [
        t.tier,
        {
          reviewers: t.reviewers,
          assigned: t.assigned,
          submitted: t.submitted,
          outstanding: t.outstanding,
          late: t.late,
          latePeople: t.latePeople,
          submittedLate: t.submittedLate,
          assignedAfterDue: t.assignedAfterDue,
        },
      ]),
    );
  const states = (r: TierProgressReport) => Object.fromEntries(r.dropout.rows.map((d) => [key(d), d.state]));

  it("late by tier, at open and at close", () => {
    expect(R.tpOpen!.tiers.map((t) => t.tier)).toEqual(["senior", "junior", "reserve-active", "reserve-pool"]);
    expect(counts(R.tpOpen!)).toEqual(X.TIERS_AT_OPEN);
    expect(counts(R.tpClose!)).toEqual(X.TIERS_AT_CLOSE);
    expect(R.tpOpen!.late.map(key).sort()).toEqual(X.LATE_AT_OPEN);
    expect(R.tpClose!.late.map(key).sort()).toEqual(X.LATE_AT_CLOSE);
  });

  it("reserve dropout escalation states", () => {
    expect(states(R.tpOpen!)).toEqual(X.DROPOUT_AT_OPEN);
    expect(states(R.tpClose!)).toEqual(X.DROPOUT_AT_CLOSE);
    for (const d of R.tpClose!.dropout.rows) {
      expect(d.replacedBy).toEqual(X.REPLACED_BY[key(d)] ?? []);
      expect(d.reason).toMatch(/\d+\.\d days/);
    }
    expect(R.tpOpen!.dropout.rows.find((d) => d.state === "pinged")!.pingedBy).toBe(E.ac2);
  });

  it("reserve accountability rows, worded as evidence for a human decision", () => {
    const rows = Object.fromEntries(
      R.tpClose!.accountability.rows.map((a) => [
        a.person.email,
        {
          ownPapers: a.ownPapers.map((p) => p.pid),
          assigned: a.assigned,
          submitted: a.submitted,
          lateOutstanding: a.lateOutstanding,
          submittedLate: a.submittedLate,
          thin: a.thin,
          thinPids: a.thinPids,
        },
      ]),
    );
    expect(rows).toEqual(X.ACCOUNTABILITY_AT_CLOSE);
    expect(R.tpClose!.accountability.note).toMatch(/human decision/);
  });

  it("coaching queue: junior reviews under the floor, with HotCRP review links", () => {
    const q = R.tpClose!.coaching.rows;
    expect(Object.fromEntries(q.map((c) => [key(c), c.words]))).toEqual(X.COACHING);
    for (const c of q) expect(c.hotcrpPath).toMatch(new RegExp(`^/review/${c.pid}[A-Z]+$`));
  });

  it("withhold-reviews draft (policy on): the authors' papers, as a tag CSV that is never applied", () => {
    expect([...new Set(R.tpOpen!.withhold.rows.flatMap((w) => w.withheldPids))].sort()).toEqual(X.WITHHELD_AT_OPEN);
    const w = R.tpClose!.withhold;
    expect(w.enabled).toBe(true);
    expect(w.csv).toBe(`paper,action,tag\n${X.WITHHELD_AT_CLOSE.map((p) => `${p},tag,${cfg.tierProgress!.withholdTag}`).join("\n")}\n`);
    expect(w.note).toMatch(/never applies/);
  });

  it("participation by tier (comments by reviewers on their papers)", () => {
    const p = Object.fromEntries(R.tpClose!.participation.rows.map((r) => [r.tier, { commenters: r.commenters, comments: r.comments }]));
    expect(p).toEqual(X.PARTICIPATION_AT_CLOSE);
    expect(R.tpClose!.participation.discussionOpened).toBe(false);
  });
});
