// The comment rules' comment-type options (spec §5e): SILENT_DISCUSSION,
// GONE_QUIET, AC_ABSENT and CHAMPION_MISSING can leave out non-substantive
// comments and/or pings. Default off; an unclassified comment always counts.
import { describe, expect, it } from "vitest";
import { computeAcMetrics } from "../../../src/rules/ac-metrics.js";
import { evaluateAll } from "../../../src/rules/evaluate.js";
import { paperFacts, type PaperBundle } from "../../../src/rules/facts.js";
import type { CommentView, SnapshotView } from "../../../src/rules/model.js";
import * as R from "../../../src/rules/rules.js";
import type { RuleContext } from "../../../src/rules/context.js";
import { comment, contextAt, day, paper, review } from "../../fixtures/builder.js";

const AC = "ac@example.org";
const A = "ra@example.org";
const B = "rb@example.org";
const C = "rc@example.org";
const MID = contextAt("2030-02-26T12:00");
const ignoring = (env: Record<string, string>) => contextAt("2030-02-26T12:00", env);

let nextCid = 1;
const cm = (email: string, time: number, kind?: CommentView["kind"], extra: Partial<Parameters<typeof comment>[0]> = {}) =>
  comment({ cid: nextCid++, pid: 1, email, time, ...(kind !== undefined ? { kind } : {}), ...extra });

const reviews = (merits: [number, number, number] = [3, 3, 4]) =>
  [A, B, C].map((email, i) => review({ rid: i + 1, pid: 1, email, merit: merits[i]!, ordinal: "ABC"[i]! }));

const bundle = (comments: CommentView[], merits?: [number, number, number]): PaperBundle => ({
  paper: paper(1),
  acs: [AC],
  reviews: reviews(merits),
  comments: [...comments].sort((x, y) => x.time - y.time),
});
const run = (rule: R.Rule, b: PaperBundle, ctx: RuleContext = MID) => rule(paperFacts(b, ctx), ctx);

describe("SILENT_DISCUSSION", () => {
  const b = () => bundle([cm(A, day(3), "nonsubstantive"), cm(AC, day(4), "ping")]);
  it("counts every comment by default", () => {
    expect(run(R.silentDiscussion, b())).toBeNull();
  });
  it("fires when the only comments are ignored types, and says how many", () => {
    const ctx = ignoring({ PCS_RULE_SILENT_DISCUSSION_IGNORE_NONSUBSTANTIVE: "true", PCS_RULE_SILENT_DISCUSSION_IGNORE_PINGS: "true" });
    expect(run(R.silentDiscussion, b(), ctx)).toBe("0 comments since discussion opened 14.5 days ago (2 non-substantive or ping comments not counted)");
  });
  it("one ignored type is not enough while the other counts", () => {
    expect(run(R.silentDiscussion, b(), ignoring({ PCS_RULE_SILENT_DISCUSSION_IGNORE_PINGS: "true" }))).toBeNull();
  });
  it("an unclassified comment always counts", () => {
    const ctx = ignoring({ PCS_RULE_SILENT_DISCUSSION_IGNORE_NONSUBSTANTIVE: "true" });
    expect(run(R.silentDiscussion, bundle([cm(A, day(3))]), ctx)).toBeNull();
  });
  it("DEADLINE_NO_CONSENSUS's 'silent' follows the setting", () => {
    const late = contextAt("2030-03-01T12:00", { PCS_RULE_SILENT_DISCUSSION_IGNORE_NONSUBSTANTIVE: "true" });
    expect(run(R.deadlineNoConsensus, bundle([cm(A, day(3), "nonsubstantive")]), late)).toMatch(/no discussion comments$/);
    expect(run(R.deadlineNoConsensus, bundle([cm(A, day(3), "nonsubstantive")]), contextAt("2030-03-01T12:00"))).toBeNull();
  });
});

describe("GONE_QUIET", () => {
  // A real comment on day +5, then only "+1"s up to day +13.
  const b = () => bundle([cm(A, day(5), "discussion"), cm(B, day(12), "nonsubstantive"), cm(C, day(13), "nonsubstantive")]);
  it("non-substantive comments are activity by default", () => {
    expect(run(R.goneQuiet, b())).toBeNull();
  });
  it("ignoring them, quiet time runs from the last counted comment", () => {
    const r = run(R.goneQuiet, b(), ignoring({ PCS_RULE_GONE_QUIET_IGNORE_NONSUBSTANTIVE: "true" }));
    expect(r).toBe("no in-HotCRP activity for 9 days (limit 4 days); last activity 9 days ago (2 non-substantive comments not counted)");
  });
  it("reviews still count as activity", () => {
    const ctx = ignoring({ PCS_RULE_GONE_QUIET_IGNORE_PINGS: "true" });
    const late = review({ rid: 9, pid: 1, email: A, merit: 3, ordinal: "D", submittedAt: day(12) });
    const bb = { ...bundle([cm(AC, day(13), "ping")]), reviews: [...reviews(), late] };
    expect(run(R.goneQuiet, bb, ctx)).toBeNull();
  });
});

describe("AC_ABSENT", () => {
  it("an AC whose only comment is a ping still counts by default, not when pings are ignored", () => {
    const b = bundle([cm(AC, day(2), "ping"), cm(A, day(3), "discussion")]);
    expect(run(R.acAbsent, b)).toBeNull();
    expect(run(R.acAbsent, b, ignoring({ PCS_RULE_AC_ABSENT_IGNORE_PINGS: "true" }))).toBe(
      "no AC comment since discussion opened 14.5 days ago (1 AC) (1 ping comment not counted)",
    );
  });
  it("a reviewer's comments never stand in for the AC's", () => {
    const b = bundle([cm(A, day(3), "discussion")]);
    expect(run(R.acAbsent, b, ignoring({ PCS_RULE_AC_ABSENT_IGNORE_PINGS: "true" }))).toBe("no AC comment since discussion opened 14.5 days ago (1 AC)");
  });
});

describe("CHAMPION_MISSING", () => {
  it("a champion who only said '+1' isn't championing when non-substantive comments are ignored", () => {
    const b = bundle([cm(C, day(4), "nonsubstantive")], [3, 3, 5]);
    expect(run(R.championMissing, b)).toBeNull();
    expect(run(R.championMissing, b, ignoring({ PCS_RULE_CHAMPION_MISSING_IGNORE_NONSUBSTANTIVE: "true" }))).toBe(
      "top merit 5 (1 reviewer); no comment from that reviewer since discussion opened (1 non-substantive comment not counted)",
    );
  });
  it("other people's comments don't matter", () => {
    const b = bundle([cm(C, day(4), "discussion"), cm(A, day(5), "nonsubstantive")], [3, 3, 5]);
    expect(run(R.championMissing, b, ignoring({ PCS_RULE_CHAMPION_MISSING_IGNORE_NONSUBSTANTIVE: "true" }))).toBeNull();
  });
});

describe("AC nudges with the classifier", () => {
  const snap = (commentClassifier: SnapshotView["commentClassifier"]): SnapshotView => ({
    papers: [paper(1)],
    people: [],
    acs: [{ pid: 1, email: AC }],
    reviews: reviews(),
    comments: [
      cm(AC, day(1), "discussion"), // posted while reviewers are silent: a proxy nudge, not a ping
      cm(AC, day(2), "ping", { mentions: [A] }),
      cm(AC, day(3), "ping"),
      cm(A, day(4), "reply"),
    ],
    commentClassifier,
  });
  it("counts pings and names the classifier", () => {
    const [m] = computeAcMetrics(evaluateAll(snap("heuristic"), MID), MID);
    expect(m!.nudges).toEqual({ total: 2, mentions: 1, proxy: 2, pings: 2, source: "heuristic" });
  });
  it("falls back to the proxy without a classifier", () => {
    const [m] = computeAcMetrics(evaluateAll(snap(null), MID), MID);
    expect(m!.nudges).toEqual({ total: 3, mentions: 1, proxy: 2, pings: 2, source: "proxy" });
  });
});
