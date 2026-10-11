// Flag history (spec §5c): event derivation (raise/clear), cause attribution,
// collapsing repeats, intervals and the count series, "why" explanations,
// and rewinding a snapshot to an instant. Synthetic data only.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RuleName } from "../../src/config.js";
import { explainEvent } from "../../src/history/explain.js";
import { flagEvents, flagSeries, historySince, intervalsOf, recordFlags } from "../../src/history/flags.js";
import { snapshotAt } from "../../src/history/snapshot-at.js";
import { analyze, indexSnapshot, type PaperResult } from "../../src/rules/index.js";
import { DAY_MS } from "../../src/rules/phase.js";
import { memoryStore, type Store } from "../../src/store/store.js";
import { comment, contextAt, day, DISCUSSION_OPEN, paper, review } from "../fixtures/builder.js";
import { goldenSnapshot, GOLDEN_EXPECTED } from "../fixtures/golden.js";

const result = (pid: number, rules: RuleName[]): PaperResult => ({
  pid,
  severity: rules.length,
  fired: rules.map((rule) => ({ rule, weight: 1, reason: `${rule} reason for #${pid}` })),
  lastActivity: null,
  decisionsDue: 0,
});

let store: Store;
beforeEach(() => {
  store = memoryStore();
});
afterEach(() => store.close());

describe("recordFlags", () => {
  it("the first recording is the baseline; later ones raise and clear with their cause", () => {
    const t0 = day(1);
    const b = recordFlags(store.db, [result(1, ["SPLIT"]), result(2, [])], { atMs: t0, cause: "data", syncRunId: 1 });
    expect(b).toEqual({ raised: 1, cleared: 0, baseline: true });
    expect(historySince(store.db)).toBe(Math.floor(t0 / 1000) * 1000);

    // Unchanged state: no events, even with a new reason string.
    const same = recordFlags(store.db, [{ ...result(1, ["SPLIT"]), fired: [{ rule: "SPLIT", weight: 1, reason: "new numbers" }] }], { atMs: day(2), cause: "data" });
    expect(same).toEqual({ raised: 0, cleared: 0, baseline: false });

    recordFlags(store.db, [result(1, ["SPLIT", "GONE_QUIET"]), result(2, ["AC_ABSENT"])], { atMs: day(3), cause: "data", syncRunId: 2 });
    recordFlags(store.db, [result(1, []), result(2, ["AC_ABSENT"])], { atMs: day(4), cause: "rules", revisionId: 7, syncRunId: 99 });

    const evs = flagEvents(store.db).map((e) => [e.pid, e.rule, e.kind, e.cause, e.syncRunId, e.revisionId, e.since === null ? null : (e.at - e.since) / DAY_MS]);
    expect(evs).toEqual([
      [1, "SPLIT", "raised", "baseline", 1, null, null],
      [1, "GONE_QUIET", "raised", "data", 2, null, 1],
      [2, "AC_ABSENT", "raised", "data", 2, null, 1],
      [1, "GONE_QUIET", "cleared", "rules", 99, 7, 1],
      [1, "SPLIT", "cleared", "rules", 99, 7, 1],
    ]);
    expect(flagEvents(store.db, { pid: 1, order: "desc", limit: 1 })[0]).toMatchObject({ kind: "cleared", rule: "SPLIT" });
    expect(flagEvents(store.db, { rules: ["AC_ABSENT"] }).map((e) => e.pid)).toEqual([2]);
    expect(flagEvents(store.db, { pids: [2] }).map((e) => e.rule)).toEqual(["AC_ABSENT"]);
  });

  it("a paper missing from the evaluation (gone from the store) is cleared", () => {
    recordFlags(store.db, [result(1, ["SPLIT"])], { atMs: day(1), cause: "data" });
    expect(recordFlags(store.db, [], { atMs: day(2), cause: "data" })).toMatchObject({ cleared: 1 });
  });
});

describe("collapsing and intervals", () => {
  const ins = (pid: number, rule: string, kind: string, atMs: number, reconstructed = 0, cause = "data") =>
    store.db
      .prepare("insert into flag_event (pid, rule, kind, at, cause, reconstructed) values (?, ?, ?, ?, ?, ?)")
      .run(pid, rule, kind, Math.floor(atMs / 1000), cause, reconstructed);

  it("drops a raise while open and a clear while closed; reconstructed rows sort first at the same instant", () => {
    const base = day(10);
    // The reconstruction opened SPLIT on day 1; the baseline's raise at day 10 is a continuation.
    ins(1, "SPLIT", "raised", base, 0, "baseline");
    ins(1, "SPLIT", "raised", day(1), 1);
    // Reconstructed: open on day 2, cleared by the time history began (day 10, same instant as the baseline).
    ins(1, "GONE_QUIET", "raised", day(2), 1);
    ins(1, "GONE_QUIET", "cleared", base, 1);
    ins(1, "GONE_QUIET", "cleared", day(11)); // stray: already closed
    ins(1, "GONE_QUIET", "raised", day(12));
    const evs = flagEvents(store.db, { pid: 1 });
    expect(evs.map((e) => [e.rule, e.kind, (e.at - DISCUSSION_OPEN) / DAY_MS - 0.5])).toEqual([
      ["SPLIT", "raised", 1],
      ["GONE_QUIET", "raised", 2],
      ["GONE_QUIET", "cleared", 10],
      ["GONE_QUIET", "raised", 12],
    ]);
    const ivs = intervalsOf(evs);
    expect(ivs.map((iv) => [iv.rule, iv.raised.reconstructed, iv.cleared === null])).toEqual([
      ["SPLIT", true, true],
      ["GONE_QUIET", true, false],
      ["GONE_QUIET", false, true],
    ]);
  });

  it("counts open flags per rule and flagged papers per day", () => {
    ins(1, "SPLIT", "raised", day(0));
    ins(2, "SPLIT", "raised", day(1));
    ins(2, "GONE_QUIET", "raised", day(1));
    ins(1, "SPLIT", "cleared", day(2));
    const s = flagSeries(flagEvents(store.db), ["SPLIT", "GONE_QUIET"], day(0), day(3));
    expect(s.ts).toHaveLength(4);
    expect(s.byRule.SPLIT).toEqual([1, 2, 1, 1]);
    expect(s.byRule.GONE_QUIET).toEqual([0, 1, 1, 1]);
    expect(s.flagged).toEqual([1, 2, 1, 1]);
  });
});

describe("explainEvent", () => {
  const snap = goldenSnapshot();
  const b6 = indexSnapshot(snap).byPid.get(6)!;
  const b3 = indexSnapshot(snap).byPid.get(3)!;

  it("names the trigger in the window, the rule revision, or the baseline", () => {
    expect(explainEvent({ cause: "rules", revisionId: 3, since: null, at: day(5) }, b6)).toBe("after rule change #3");
    expect(explainEvent({ cause: "baseline", revisionId: null, since: null, at: day(5) }, b6)).toBe("already flagged when history began");
    // pid 3's low reviewer moved 1 -> 2 on day +6.
    expect(explainEvent({ cause: "data", revisionId: null, since: day(5.5), at: day(6.5) }, b3)).toBe("after a merit change 1→2");
    // Nothing happened on pid 6 after day +2: going quiet is just time passing.
    expect(explainEvent({ cause: "data", revisionId: null, since: day(6), at: day(7) }, b6)).toBeNull();
  });

  it("an AC comment vs a reviewer comment", () => {
    const s = {
      papers: [paper(1)],
      people: [],
      acs: [{ pid: 1, email: "ac@example.org" }],
      reviews: [review({ rid: 1, pid: 1, email: "rev@example.org" })],
      comments: [comment({ cid: 1, pid: 1, email: "rev@example.org", time: day(1) }), comment({ cid: 2, pid: 1, email: "ac@example.org", time: day(3) })],
    };
    const b = indexSnapshot(s).byPid.get(1)!;
    expect(explainEvent({ cause: "data", revisionId: null, since: day(2), at: day(4) }, b)).toBe("after AC comment");
    expect(explainEvent({ cause: "data", revisionId: null, since: day(0), at: day(2) }, b)).toBe("after reviewer comment");
  });
});

describe("snapshotAt", () => {
  it("rewinds decisions, review versions and comments", () => {
    const s = goldenSnapshot();
    const t = day(3);
    const r = snapshotAt(s, t);
    expect(r.comments.every((c) => c.time <= t)).toBe(true);
    expect(r.comments.length).toBeLessThan(s.comments.length);
    // pid 1 was decided on day +10: undecided on day +3.
    expect(r.papers.find((p) => p.pid === 1)!.decision).toBeNull();
    // pid 3's mover still has merit 1 on day +3.
    const ctx = contextAt(t);
    const a = analyze(r, ctx);
    expect(a.evaluation.byPid.get(3)!.fired.map((f) => f.rule)).toContain("SPLIT");
    expect(a.evaluation.facts.get(3)!.merits).toContain(1);
    // At the golden instant the rewind is the identity for the rules.
    const now = contextAt("2030-02-26T12:00");
    const same = analyze(snapshotAt(s, now.now), now);
    for (const [pid, rules] of Object.entries(GOLDEN_EXPECTED)) {
      expect(same.evaluation.byPid.get(Number(pid))!.fired.map((f) => f.rule).sort(), `pid ${pid}`).toEqual([...rules].sort());
    }
  });

  it("before a review's first version it is assigned but unsubmitted", () => {
    const rv = review({ rid: 1, pid: 1, email: "rev@example.org", submittedAt: day(-3), merit: 4 });
    const s = { papers: [paper(1)], people: [], acs: [], reviews: [rv], comments: [] };
    expect(snapshotAt(s, day(-2)).reviews[0]).toMatchObject({ status: "complete", merit: 4 });
    const early = snapshotAt(s, day(-40)).reviews[0]!;
    expect(early).toMatchObject({ merit: null, firstCompleteSeenAt: null });
  });
});
