// Process report (spec §10.4 G, PLAN M13). Pure: (snapshot index, M12
// reports, imports summary, settings) -> aggregates. O(rows). One function per
// metric; each row carries a reason string with its numbers.
//
// Definitions (spec §10.4 G repeats them):
// - Reviewer review: not a metareview (rtype 5) and not held by one of the
//   paper's ACs (as in M12). Its tier is the reviewer's tier.
// - Submitted: delivered / approved / complete. Its submission time is the
//   first submitted version (M12 submittedAt: HotCRP modified_at, else when a
//   sync saw it).
// - Assigned after the deadline: first seen by a sync after REVIEW_DUE, not at
//   the first sync (M12). Such replacements are never late.
// - Paper mean merit: the mean of the paper's submitted reviewer merits, on
//   papers with at least 2. A merit's deviation is |merit - that mean|.
// - Decision side: a decision whose name starts (case-insensitively) with one
//   of PCS_REPORT_ACCEPT_DECISIONS is accept; any other decision is reject;
//   no decision is undecided. A merit is on the decision's side when it is
//   >= PCS_MERIT_ACCEPT_MIN on an accepted paper, or below it on a rejected one.
//
// Small cells: a group of people (a tier; the reserve reviewers) with fewer
// than PCS_REPORT_MIN_CELL distinct people is suppressed: every number in its
// row is null, `suppressed` is true, and the reason says why. Paper counts
// (early reject, quick reject, totals) describe papers, not people, and are
// not suppressed.

import { addRatings, RATING_FLAGS, ratingTotal, type RatingCounts, type RatingFlag } from "../../ratings.js";
import type { RuleContext } from "../../rules/context.js";
import { isSubmitted, median, percentile, type SnapshotIndex } from "../../rules/facts.js";
import { DEFAULT_TIER, type Millis } from "../../rules/model.js";
import { DAY_MS } from "../../rules/phase.js";
import type { EarlyRejectReport } from "../early-reject/types.js";
import { submittedAt } from "../tier-progress/compute.js";
import type { TierProgressReport } from "../tier-progress/types.js";
import type {
  AgreementRow,
  Bin,
  Cell,
  DepthRow,
  EarlyRejectYield,
  MeritRow,
  RatingRow,
  ReserveSection,
  TimelinessRow,
} from "./types.js";

export type DecisionSide = "accept" | "reject" | null;

/** One reviewer review with everything the report and the export need. */
export interface ReviewFact {
  pid: number;
  rid: number;
  email: string;
  tier: string;
  rtype: number;
  submitted: boolean;
  merit: number | null;
  expertise: number | null;
  words: number;
  /** Raters per rating flag (ratings.ts); {} when unrated or ratings are off. */
  ratings: RatingCounts;
  /** First submitted version time, or null. */
  submittedAt: Millis | null;
  assignedAfterDue: boolean;
  /** (submittedAt - REVIEW_DUE) in days, or null. */
  daysVsDue: number | null;
  /** Submitted after REVIEW_DUE, and not a replacement. */
  late: boolean;
  /** Mean of the paper's submitted reviewer merits (>= 2 of them), else null. */
  paperMean: number | null;
  absDev: number | null;
  side: DecisionSide;
  /** On the decision's side (null when undecided or no merit). */
  onSide: boolean | null;
}

export interface FactOptions {
  approxRids: ReadonlySet<number>;
  acceptDecisions: readonly string[];
}

const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
const pct = (x: number | null) => (x === null ? "n/a" : `${Math.round(x * 100)}%`);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const mean = (xs: readonly number[]) => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);
const share = (num: number, den: number) => (den === 0 ? null : num / den);

export function decisionSide(decision: string | null, acceptPrefixes: readonly string[]): DecisionSide {
  if (decision === null) return null;
  const d = decision.trim().toLowerCase();
  return acceptPrefixes.some((p) => d.startsWith(p)) ? "accept" : "reject";
}

/** Every reviewer review on a live paper, as facts (one pass). */
export function reviewFacts(index: SnapshotIndex, ctx: RuleContext, o: FactOptions): ReviewFact[] {
  const due = ctx.phases.reviewDue;
  const out: ReviewFact[] = [];
  for (const b of index.bundles) {
    const acs = new Set(b.acs);
    const rr = b.reviews.filter((r) => r.rtype !== 5 && !acs.has(r.email));
    const merits = rr.filter((r) => isSubmitted(r) && r.merit !== null).map((r) => r.merit!);
    const paperMean = merits.length >= 2 ? mean(merits) : null;
    const side = decisionSide(b.paper.decision, o.acceptDecisions);
    for (const r of rr) {
      const submitted = isSubmitted(r);
      const at = submitted ? submittedAt(r) : null;
      const assignedAfterDue = !o.approxRids.has(r.rid) && r.firstSeenAt > due && r.firstSeenAt <= ctx.now;
      const merit = submitted ? r.merit : null;
      out.push({
        pid: b.paper.pid,
        rid: r.rid,
        email: r.email,
        tier: index.people.get(r.email)?.tier ?? DEFAULT_TIER,
        rtype: r.rtype,
        submitted,
        merit,
        expertise: submitted ? r.expertise : null,
        words: submitted ? r.wordCount : 0,
        ratings: r.ratings,
        submittedAt: at,
        assignedAfterDue,
        daysVsDue: at === null ? null : (at - due) / DAY_MS,
        late: at !== null && at > due && !assignedAfterDue,
        paperMean: merit !== null && paperMean !== null ? paperMean : null,
        absDev: merit !== null && paperMean !== null ? Math.abs(merit - paperMean) : null,
        side,
        onSide: merit === null || side === null ? null : side === "accept" ? merit >= ctx.meritAcceptMin : merit < ctx.meritAcceptMin,
      });
    }
  }
  return out;
}

/** Tiers in display order: the configured order, then any other tier seen. */
export function tierOrder(configured: readonly string[], facts: readonly ReviewFact[]): string[] {
  const out = [...configured];
  for (const f of facts) if (!out.includes(f.tier)) out.push(f.tier);
  return out;
}

function groupByTier(facts: readonly ReviewFact[], tiers: readonly string[]): Map<string, ReviewFact[]> {
  const m = new Map<string, ReviewFact[]>(tiers.map((t) => [t, []]));
  for (const f of facts) m.get(f.tier)?.push(f);
  return m;
}

/** The small-cell rule: fewer than minCell distinct people -> suppressed. */
export function cellOf(people: number, minCell: number): Cell {
  return people < minCell ? { people: null, suppressed: true } : { people, suppressed: false };
}

const suppressedReason = (minCell: number) => `fewer than PCS_REPORT_MIN_CELL=${minCell} people; numbers withheld`;
const peopleIn = (fs: readonly ReviewFact[]) => new Set(fs.map((f) => f.email)).size;

/** Word-count bins (display only; the floor PCS_THRESH_MIN_WORDS is reported separately). */
export const WORD_BINS: readonly number[] = [0, 100, 200, 400, 700, 1000];

export function binWords(words: readonly number[], edges: readonly number[] = WORD_BINS): Bin[] {
  return edges.map((from, i) => {
    const to = edges[i + 1];
    return {
      label: to === undefined ? `${from}+` : `${from}–${to - 1}`,
      from,
      count: words.filter((w) => w >= from && (to === undefined || w < to)).length,
    };
  });
}

/** Junior vs senior depth: words in submitted reviewer reviews, per tier. */
export function depthByTier(facts: readonly ReviewFact[], tiers: readonly string[], minCell: number, minWords: number): DepthRow[] {
  return [...groupByTier(facts, tiers)].map(([tier, fs]) => {
    const sub = fs.filter((f) => f.submitted);
    const c = cellOf(peopleIn(sub), minCell);
    if (c.suppressed) {
      return { tier, ...c, reviews: null, median: null, p25: null, p75: null, mean: null, underFloor: null, bins: null, reason: suppressedReason(minCell) };
    }
    const w = sub.map((f) => f.words);
    const m = median(w);
    const under = w.filter((x) => x < minWords).length;
    const avg = mean(w);
    return {
      tier,
      ...c,
      reviews: w.length,
      median: m,
      p25: percentile(w, 25),
      p75: percentile(w, 75),
      mean: avg === null ? null : round(avg, 1),
      underFloor: under,
      bins: binWords(w),
      reason: `${plural(w.length, "submitted review")} by ${plural(c.people!, "reviewer")}: median ${m ?? "n/a"} words (p25 ${percentile(w, 25) ?? "n/a"}, p75 ${percentile(w, 75) ?? "n/a"}); ${under} under PCS_THRESH_MIN_WORDS=${minWords}`,
    };
  });
}

/** Timeliness: first submission vs REVIEW_DUE, per tier. */
export function timelinessByTier(facts: readonly ReviewFact[], tiers: readonly string[], minCell: number): TimelinessRow[] {
  return [...groupByTier(facts, tiers)].map(([tier, fs]) => {
    const c = cellOf(peopleIn(fs), minCell);
    if (c.suppressed) {
      return {
        tier,
        ...c,
        assigned: null,
        submitted: null,
        onTime: null,
        late: null,
        assignedAfterDue: null,
        notSubmitted: null,
        onTimeShare: null,
        medianDaysVsDue: null,
        reason: suppressedReason(minCell),
      };
    }
    const sub = fs.filter((f) => f.submitted);
    const late = sub.filter((f) => f.late).length;
    const after = fs.filter((f) => f.assignedAfterDue).length;
    const onTime = sub.filter((f) => !f.late && !f.assignedAfterDue).length;
    const days = sub.filter((f) => f.daysVsDue !== null && !f.assignedAfterDue).map((f) => f.daysVsDue!);
    const md = median(days);
    const due = fs.length - after;
    const onTimeShare = share(onTime, due);
    return {
      tier,
      ...c,
      assigned: fs.length,
      submitted: sub.length,
      onTime,
      late,
      assignedAfterDue: after,
      notSubmitted: fs.length - sub.length,
      onTimeShare,
      medianDaysVsDue: md === null ? null : round(md, 1),
      reason:
        `${onTime} of ${due} reviews due by the deadline submitted on time (${pct(onTimeShare)}), ${late} late, ${fs.length - sub.length} not submitted` +
        `${after ? `; ${after} assigned after the deadline` : ""}; median ${md === null ? "n/a" : `${Math.abs(md).toFixed(1)} days ${md <= 0 ? "before" : "after"}`} the deadline`,
    };
  });
}

/** Merit values from the lowest to the highest seen (shared by every tier). */
export function meritRange(facts: readonly ReviewFact[]): number[] {
  const ms = facts.filter((f) => f.merit !== null).map((f) => f.merit!);
  if (ms.length === 0) return [];
  const lo = Math.min(...ms);
  const hi = Math.max(...ms);
  return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
}

/** The merit distribution of submitted reviewer reviews, per tier. */
export function meritsByTier(facts: readonly ReviewFact[], tiers: readonly string[], minCell: number): MeritRow[] {
  const range = meritRange(facts);
  return [...groupByTier(facts, tiers)].map(([tier, fs]) => {
    const ms = fs.filter((f) => f.merit !== null);
    const c = cellOf(peopleIn(ms), minCell);
    if (c.suppressed) return { tier, ...c, reviews: null, bins: null, mean: null, reason: suppressedReason(minCell) };
    const avg = mean(ms.map((f) => f.merit!));
    const bins = range.map((v) => ({ label: String(v), from: v, count: ms.filter((f) => f.merit === v).length }));
    return {
      tier,
      ...c,
      reviews: ms.length,
      bins,
      mean: avg === null ? null : round(avg),
      reason: `${plural(ms.length, "merit")}: ${bins.map((b) => `${b.label}×${b.count}`).join(", ") || "none"}; mean ${avg === null ? "n/a" : round(avg)}`,
    };
  });
}

/**
 * Rating-flag distributions on submitted reviewer reviews, per tier (spec
 * §10.4 G): flags received (raters per flag, summed), and flags per review.
 * `names` = the flags seen anywhere, in HotCRP's order. Ratings off: no rows.
 */
export function ratingsByTier(
  facts: readonly ReviewFact[],
  tiers: readonly string[],
  minCell: number,
  enabled = true,
): { enabled: boolean; names: string[]; rows: RatingRow[] } {
  if (!enabled) return { enabled, names: [], rows: [] };
  const seen: Partial<Record<RatingFlag, number>> = {};
  for (const f of facts) if (f.submitted) addRatings(seen, f.ratings);
  const names = RATING_FLAGS.filter((n) => (seen[n] ?? 0) > 0);
  const rows = [...groupByTier(facts, tiers)].map(([tier, fs]): RatingRow => {
    const sub = fs.filter((f) => f.submitted);
    const c = cellOf(peopleIn(sub), minCell);
    if (c.suppressed) return { tier, ...c, reviews: null, rated: null, counts: null, perReview: null, reason: suppressedReason(minCell) };
    const sum: Partial<Record<RatingFlag, number>> = {};
    for (const f of sub) addRatings(sum, f.ratings);
    const counts: Record<string, number> = Object.fromEntries(names.map((n) => [n, sum[n] ?? 0]));
    const perReview: Record<string, number> = Object.fromEntries(names.map((n) => [n, sub.length ? round((sum[n] ?? 0) / sub.length) : 0]));
    const rated = sub.filter((f) => ratingTotal(f.ratings) > 0).length;
    return {
      tier,
      ...c,
      reviews: sub.length,
      rated,
      counts,
      perReview,
      reason:
        `${rated} of ${plural(sub.length, "submitted review")} rated` +
        (names.length ? `; flags received: ${names.map((n) => `${counts[n]}× ${n} (${perReview[n]}/review)`).join(", ")}` : ""),
    };
  });
  return { enabled, names, rows };
}

/** Score agreement: deviation from the paper's mean merit, and the decision side, per tier. */
export function agreementByTier(facts: readonly ReviewFact[], tiers: readonly string[], minCell: number, acceptMin: number): AgreementRow[] {
  return [...groupByTier(facts, tiers)].map(([tier, fs]) => {
    const withMean = fs.filter((f) => f.absDev !== null);
    const c = cellOf(peopleIn(fs.filter((f) => f.merit !== null)), minCell);
    if (c.suppressed) {
      return { tier, ...c, reviews: null, meanAbsDev: null, decided: null, onDecisionSide: null, share: null, reason: suppressedReason(minCell) };
    }
    const mad = mean(withMean.map((f) => f.absDev!));
    const decided = fs.filter((f) => f.onSide !== null);
    const on = decided.filter((f) => f.onSide).length;
    const s = share(on, decided.length);
    return {
      tier,
      ...c,
      reviews: withMean.length,
      meanAbsDev: mad === null ? null : round(mad),
      decided: decided.length,
      onDecisionSide: on,
      share: s,
      reason:
        `mean |merit − paper mean| ${mad === null ? "n/a" : round(mad)} over ${plural(withMean.length, "merit")} on papers with 2+ merits; ` +
        (decided.length === 0
          ? "no decided papers yet"
          : `${on} of ${decided.length} merits on decided papers on the decision's side (${pct(s)}; accept side = merit ≥ PCS_MERIT_ACCEPT_MIN=${acceptMin})`),
    };
  });
}

export interface ReserveOptions {
  reserveTiers: readonly string[];
  /** The tier name for designated, not-activated reserve reviewers. */
  poolTier: string;
  minCell: number;
  /** Latest invites import (rows), or null when none. */
  invites: readonly { candidate_email: string; ac_decision: string; response: string; activated_at: number | null }[] | null;
}

/** Reserve activation and dropout (reuses M12 tier-progress for the reviews). */
export function reserveSection(index: SnapshotIndex, tp: TierProgressReport, o: ReserveOptions): ReserveSection {
  const tiers = [...o.reserveTiers, ...(o.reserveTiers.includes(o.poolTier) ? [] : [o.poolTier])];
  const people = [...index.people.values()];
  const active = people.filter((p) => o.reserveTiers.includes(p.tier) && p.tier !== o.poolTier).length;
  const pool = people.filter((p) => p.tier === o.poolTier).length;
  const rows = tp.tiers.filter((t) => o.reserveTiers.includes(t.tier));
  const reviewers = rows.reduce((a, t) => a + t.reviewers, 0);
  const c = cellOf(Math.max(reviewers, active), o.minCell);
  const empty = {
    tiers,
    ...c,
    active: null,
    pool: null,
    activationRate: null,
    invites: null,
    assigned: null,
    submitted: null,
    notSubmitted: null,
    submittedLate: null,
    dropoutRate: null,
    lateNow: null,
  };
  if (c.suppressed) return { ...empty, reason: `reserve reviewers (${tiers.join(", ") || "none configured"}): ${suppressedReason(o.minCell)}` };
  const sum = (k: "assigned" | "submitted" | "submittedLate") => rows.reduce((a, t) => a + t[k], 0);
  const assigned = sum("assigned");
  const submitted = sum("submitted");
  const submittedLate = sum("submittedLate");
  const notSubmitted = assigned - submitted;
  const dropoutRate = share(notSubmitted + submittedLate, assigned);
  let invites: ReserveSection["invites"] = null;
  let activationRate: number | null;
  let activation: string;
  if (o.invites) {
    const approved = new Set(o.invites.filter((r) => r.ac_decision === "approve").map((r) => r.candidate_email));
    const activated = new Set(o.invites.filter((r) => r.activated_at !== null).map((r) => r.candidate_email));
    invites = {
      rows: o.invites.length,
      approved: o.invites.filter((r) => r.ac_decision === "approve").length,
      accepted: o.invites.filter((r) => r.response === "accept").length,
      declined: o.invites.filter((r) => r.response === "decline").length,
      activated: o.invites.filter((r) => r.activated_at !== null).length,
    };
    activationRate = share([...activated].filter((e) => approved.has(e)).length, approved.size);
    activation = `${pct(activationRate)} of AC-approved candidates activated (invites import: ${invites.rows} rows, ${invites.approved} approved, ${invites.activated} activated)`;
  } else {
    activationRate = share(active, active + pool);
    activation = active + pool === 0 ? "no reserve reviewers designated" : `${active} active of ${active + pool} designated (${pct(activationRate)}; no invites import)`;
  }
  return {
    ...empty,
    active,
    pool,
    activationRate,
    invites,
    assigned,
    submitted,
    notSubmitted,
    submittedLate,
    dropoutRate,
    lateNow: { ...tp.dropout.counts },
    reason: `${activation}; ${notSubmitted} of ${plural(assigned, "reserve review")} not submitted and ${submittedLate} submitted late (dropout ${pct(dropoutRate)})`,
  };
}

/** Early-reject yield (reuses M12 early-reject): candidates, bumped, rejected in the end. */
export function earlyRejectYield(er: EarlyRejectReport, index: SnapshotIndex, acceptDecisions: readonly string[]): EarlyRejectYield {
  const sides = er.candidates.map((c) => decisionSide(index.byPid.get(c.pid)?.paper.decision ?? null, acceptDecisions));
  const rejected = sides.filter((s) => s === "reject").length;
  const accepted = sides.filter((s) => s === "accept").length;
  const n = er.candidates.length;
  const y = share(rejected, n);
  const reason =
    er.status === "unconfigured"
      ? "the early-reject window is not configured (PCS_PHASE_EARLYREJECT_OPEN)"
      : `${plural(n, "candidate")} (${er.policy}); ${er.bumped.length} bumped, ${er.notBumped.length} not bumped; ${rejected} rejected in the end, ${accepted} accepted, ${n - rejected - accepted} undecided (yield ${pct(y)})`;
  return { status: er.status, candidates: n, bumped: er.bumped.length, notBumped: er.notBumped.length, rejected, accepted, undecided: n - rejected - accepted, yield: y, reason };
}
