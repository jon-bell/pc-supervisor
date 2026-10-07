// Early reject (spec §10.4 E, PLAN M12): pure unit tests over builder
// fixtures, at instants before, during, and after the window. Synthetic data only.
import { describe, expect, it } from "vitest";
import { DEFAULT_EARLY_REJECT, loadConfig, type EarlyRejectSettings } from "../../../src/config.js";
import { computeEarlyReject, formatter, versionAt, windowFromConfig, type EarlyRejectReport, type EarlyRejectWindow } from "../../../src/modules/early-reject/index.js";
import { indexSnapshot, type SnapshotView } from "../../../src/rules/index.js";
import { RULES_ENV, TZ, at, comment, paper, review } from "../../fixtures/builder.js";

const OPEN = at("2030-02-03T09:00");
const CLOSE = at("2030-02-05T09:00");
const WIN = { open: OPEN, close: CLOSE, closeSource: "env" as const };
const WEAK: EarlyRejectSettings = { ...DEFAULT_EARLY_REJECT, policy: "include_weak_reject" };
const em = (k: string) => `${k}@example.org`;

function world(over: Partial<SnapshotView> = {}): SnapshotView {
  const r = (rid: number, pid: number, k: string, merit: number, moves: { at: number; merit: number }[] = []) =>
    review({ rid, pid, email: em(k), merit, moves, submittedAt: at("2030-01-28T10:00") });
  return {
    papers: [paper(1), paper(2), paper(3), paper(4), paper(5)],
    people: ["a", "b", "c", "d", "ac"].map((k) => ({ email: em(k), name: k.toUpperCase(), tier: k === "c" ? "junior" : "senior", roles: ["pc"] })),
    acs: [1, 2, 3, 4, 5].map((pid) => ({ pid, email: em("ac") })),
    reviews: [
      review({ rid: 100, pid: 1, email: em("ac"), rtype: 5, merit: 5 }), // an AC review never counts
      r(11, 1, "a", 1, [{ at: at("2030-02-03T15:00"), merit: 3 }]), // raised in the window
      r(12, 1, "b", 1),
      r(13, 1, "c", 2),
      r(21, 2, "a", 1),
      r(22, 2, "b", 1, [{ at: at("2030-02-04T10:00"), merit: 1 }, { at: at("2030-02-06T10:00"), merit: 4 }]), // raised only after close
      r(23, 2, "c", 1),
      r(31, 3, "a", 2, [{ at: at("2030-02-03T08:00"), merit: 2 }]), // a version before open
      r(32, 3, "b", 2, [{ at: at("2030-02-04T11:00"), merit: 1 }]), // lowered: a response, not a bump
      r(33, 3, "d", 2),
      r(41, 4, "a", 1),
      r(42, 4, "b", 4), // out of the band
      r(43, 4, "c", 1),
      r(51, 5, "a", 1),
      r(52, 5, "b", 1), // only 2 merits
      review({ rid: 53, pid: 5, email: em("c"), status: "empty" }),
    ],
    comments: [
      comment({ cid: 1, pid: 1, email: em("b"), time: at("2030-02-02T10:00") }), // before the window
      comment({ cid: 2, pid: 2, email: em("c"), time: OPEN }), // at OPEN: counts
      comment({ cid: 3, pid: 3, email: em("d"), time: at("2030-02-05T09:01") }), // after close
      comment({ cid: 4, pid: 2, email: em("ac"), time: at("2030-02-04T09:00") }),
    ],
    ...over,
  };
}

const fmt = formatter(TZ);
const run = (now: string | number, s: SnapshotView = world(), settings = WEAK, win: EarlyRejectWindow = WIN): EarlyRejectReport =>
  computeEarlyReject(indexSnapshot(s), settings, win, typeof now === "number" ? now : at(now), { tz: TZ, fmt, syncAtOpen: OPEN });
const pairs = (r: EarlyRejectReport) => r.noResponse.map((n) => `${n.person.email.split("@")[0]}@${n.pid}`).sort();

describe("candidates", () => {
  it("include_weak_reject: every merit <= ACCEPT_MIN-1 with at least MIN_REVIEWS; reject_only: every merit <= 1", () => {
    expect(run("2030-02-03T12:00").candidates.map((c) => c.pid)).toEqual([1, 2, 3]);
    expect(run("2030-02-03T12:00", world(), DEFAULT_EARLY_REJECT).candidates.map((c) => c.pid)).toEqual([2]);
    expect(run("2030-02-03T12:00", world(), { ...WEAK, minReviews: 2 }).candidates.map((c) => c.pid)).toEqual([1, 2, 3, 5]);
  });

  it("are computed as of OPEN from the version history, whatever now is", () => {
    for (const now of ["2030-02-03T09:00", "2030-02-04T12:00", "2030-02-05T09:00", "2030-02-20T12:00"]) {
      const r = run(now);
      expect(r.candidatesAt).toBe(OPEN);
      expect(r.candidates.map((c) => [c.pid, c.meritsAtOpen])).toEqual([
        [1, [1, 1, 2]],
        [2, [1, 1, 1]],
        [3, [2, 2, 2]],
      ]);
    }
  });

  it("before the window they are provisional, as of now, with no outcomes", () => {
    const r = run("2030-02-03T08:30");
    expect(r.status).toBe("before");
    expect(r.candidatesAt).toBe(at("2030-02-03T08:30"));
    expect(r.outcomeAt).toBeNull();
    expect([r.bumped, r.notBumped, r.noResponse]).toEqual([[], [], []]);
    expect(r.candidates[0]!.reason).toMatch(/provisional/);
    expect(r.notes.join(" ")).toMatch(/has not opened/);
  });

  it("a paper decided before OPEN is no candidate; one decided during the window still is", () => {
    const s = world({ papers: [paper(1, { decision: "Rejected", decisionSeenAt: at("2030-02-02T12:00") }), paper(2, { decision: "Rejected", decisionSeenAt: at("2030-02-04T12:00") }), paper(3)] });
    const r = run("2030-02-05T12:00", s);
    expect(r.candidates.map((c) => [c.pid, c.decision])).toEqual([
      [2, "Rejected"],
      [3, null],
    ]);
  });

  it("the reason carries the numbers and the band", () => {
    const r = run("2030-02-05T09:00");
    expect(r.candidates[0]!.reason).toBe(
      "merits 1/1/2 as of window open (2030-02-03 09:00): all <= 2, 3 submitted (>= 3); by close: 1 raised (1->3), 0 comments in the window, 2 of 3 reviewers with no response",
    );
    expect(r.definition).toMatch(/include_weak_reject: every submitted reviewer merit <= 2/);
  });
});

describe("window outcome", () => {
  it("during the window: so far", () => {
    const r = run("2030-02-04T09:30");
    expect(r.status).toBe("open");
    expect(r.outcomeAt).toBe(at("2030-02-04T09:30"));
    expect(r.bumped).toEqual([1]);
    expect(pairs(r)).toEqual(["a@2", "a@3", "b@1", "b@2", "b@3", "c@1", "d@3"]);
    expect(r.candidates[0]!.reason).toMatch(/so far: 1 raised/);
  });

  it("at close: bumped = any merit raised; lowering and comments are responses; nothing after CLOSE counts", () => {
    for (const now of ["2030-02-05T09:00", "2030-02-09T12:00"]) {
      const r = run(now);
      expect(r.status).toBe(now === "2030-02-05T09:00" ? "open" : "closed");
      expect(r.outcomeAt).toBe(CLOSE);
      expect(r.bumped).toEqual([1]);
      expect(r.notBumped).toEqual([2, 3]);
      // b@2 changed 1 -> 1 (no change) and raised only after close; c@2 commented at OPEN; b@3 lowered; d@3 commented after close.
      expect(pairs(r)).toEqual(["a@2", "a@3", "b@1", "b@2", "c@1", "d@3"]);
      const p1 = r.candidates.find((c) => c.pid === 1)!;
      expect(p1.stillInBand).toBe(false);
      expect(p1.reviews.find((x) => x.rid === 11)).toMatchObject({ meritAtOpen: 1, meritNow: 3, raised: true, changed: true, noResponse: false });
      const p2 = r.candidates.find((c) => c.pid === 2)!;
      expect(p2.signals).toMatchObject({ comments: 2, windowComments: 2, acComments: 1, outstandingReviews: 0 });
      expect(r.candidates.find((c) => c.pid === 3)!.stillInBand).toBe(true);
    }
  });

  it("a review submitted during the window is a signal, not a bump", () => {
    const base = world();
    const late = review({ rid: 54, pid: 2, email: em("d"), merit: 5, submittedAt: at("2030-02-04T12:00") });
    const r = run("2030-02-05T09:00", { ...base, reviews: [...base.reviews, { ...late, versions: [{ seenAt: OPEN - 1000, merit: null, expertise: null, status: "empty" }, ...late.versions] }] });
    const p2 = r.candidates.find((c) => c.pid === 2)!;
    expect(p2.bumped).toBe(false);
    expect(p2.signals.newReviewsInWindow).toBe(1);
    expect(p2.signals.outstandingReviews).toBe(1);
    expect(p2.stillInBand).toBe(false);
  });
});

describe("window configuration and the mail draft", () => {
  it("unconfigured without PCS_PHASE_EARLYREJECT_OPEN", () => {
    const r = run("2030-02-04T12:00", world(), WEAK, { open: null, close: null, closeSource: null });
    expect(r.status).toBe("unconfigured");
    expect(r.candidates).toEqual([]);
    expect(r.mail).toBeNull();
  });

  it("close is PCS_PHASE_EARLYREJECT_CLOSE, or OPEN + PCS_EARLYREJECT_WINDOW_H", () => {
    const set = loadConfig({ ...RULES_ENV, PCS_PHASE_EARLYREJECT_OPEN: "2030-02-03T09:00", PCS_PHASE_EARLYREJECT_CLOSE: "2030-02-04T09:00" });
    expect(windowFromConfig(set)).toEqual({ open: OPEN, close: at("2030-02-04T09:00"), closeSource: "env" });
    const derived = loadConfig({ ...RULES_ENV, PCS_PHASE_EARLYREJECT_OPEN: "2030-02-03T09:00", PCS_EARLYREJECT_WINDOW_H: "36" });
    expect(windowFromConfig(derived)).toEqual({ open: OPEN, close: at("2030-02-04T21:00"), closeSource: "window-hours" });
    expect(windowFromConfig(loadConfig(RULES_ENV))).toEqual({ open: null, close: null, closeSource: null });
  });

  it("band settings: weak bound defaults to PCS_MERIT_ACCEPT_MIN - 1; min reviews to PCS_REVIEWS_REQUIRED", () => {
    expect(loadConfig({ ...RULES_ENV, PCS_MERIT_ACCEPT_MIN: "4", PCS_REVIEWS_REQUIRED: "2" }).earlyReject).toMatchObject({ weakRejectMax: 3, minReviews: 2, rejectMax: 1, policy: "reject_only" });
    expect(loadConfig({ ...RULES_ENV, PCS_MERIT_WEAK_REJECT_MAX: "2", PCS_EARLYREJECT_MIN_REVIEWS: "4" }).earlyReject).toMatchObject({ weakRejectMax: 2, minReviews: 4 });
    expect(() => loadConfig({ ...RULES_ENV, PCS_MERIT_REJECT_MAX: "2", PCS_MERIT_WEAK_REJECT_MAX: "1" })).toThrow(/PCS_MERIT_WEAK_REJECT_MAX: must not be less than PCS_MERIT_REJECT_MAX/);
    expect(() => loadConfig({ ...RULES_ENV, PCS_POLICY_EARLYREJECT: "weak" })).toThrow(/reject_only or include_weak_reject/);
  });

  it("drafts a mail-tool search and text with the window hours and the close time", () => {
    const m = run("2030-02-03T12:00").mail!;
    expect(m.search).toBe("1 2 3");
    expect(m.mailPath).toBe("/mail?to=crev&t=s&q=1%202%203");
    expect(m.searchPath).toBe("/search?q=1%202%203&t=s");
    expect(m.subject).toContain("within 48 hours");
    expect(m.body).toContain("within 48 hours (by 2030-02-05 09:00)");
  });

  it("versionAt picks the latest version at or before t", () => {
    const r = review({ rid: 1, pid: 1, email: em("a"), merit: 1, submittedAt: at("2030-01-28T10:00"), moves: [{ at: OPEN + 1, merit: 3 }] });
    expect(versionAt(r, OPEN)!.merit).toBe(1);
    expect(versionAt(r, OPEN + 1)!.merit).toBe(3);
    expect(versionAt(r, at("2030-01-01T00:00"))).toBeNull();
  });
});
