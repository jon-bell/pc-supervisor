// Reviewing progress by tier (spec §10.4 D, PLAN M12). Pure: (snapshot index,
// authorship, reviewer metrics, rule context, policy) -> report. O(rows).
//
// Definitions (spec §10.4 D repeats them):
// - Reviewer review: a review that is not a metareview (rtype 5) and whose
//   holder is not one of the paper's ACs (as in rules/facts.ts). Its tier is
//   the reviewer's tier (PCS_TIER_TAGS, else senior).
// - Outstanding: not submitted (delivered/approved/complete), on an undecided
//   paper. Decided papers (e.g. early-rejected) are left out of
//   outstanding and late.
// - Assigned after the deadline: the review was first seen by a sync after
//   REVIEW_DUE, and not at the first sync (first_seen_approx = 0). These are
//   replacements: outstanding, but never late. A review already present at
//   the first sync counts as assigned before the deadline.
// - Late: outstanding, now > REVIEW_DUE, and not assigned after the deadline.
//   lateDays = (now - REVIEW_DUE) in days.
// - Submitted late: submitted, with its first submitted version (review_version
//   time = HotCRP modified_at, else when the sync saw it; fallback
//   first_complete_seen_at) after REVIEW_DUE, and not assigned after it.
//
// Reserve dropout (reviews by PCS_RESERVE_TIERS reviewers that are late), one
// escalation state each, first match wins:
//   replaced            another reviewer review on the paper was first seen
//                       after REVIEW_DUE (non-approximate first_seen_at, and
//                       <= now): someone was added after they went late.
//   replacement-needed  lateDays > PCS_RESERVE_DROPOUT_DAYS.
//   pinged              a published non-response comment on the paper, at or
//                       after REVIEW_DUE and <= now, by one of the paper's ACs
//                       or a chair, @mentions them.
//   late                otherwise.
// HotCRP's mail log is not visible (spec §1), so a reminder sent through the
// Mail tool is not a ping here; only in-HotCRP comments are.
//
// Reserve accountability (one row per PCS_RESERVE_TIERS person with a
// reviewer review): their own papers (paper_author by email) next to
// assigned / submitted / late (outstanding + submitted late) / thin (under
// PCS_THRESH_MIN_WORDS) / rated short / rated vague. Evidence for a human
// decision; nothing is decided or applied. Sorted by email, never ranked.
//
// Coaching queue: submitted reviews by PCS_COACH_TIERS reviewers with fewer
// than PCS_COACH_MIN_WORDS (default PCS_THRESH_MIN_WORDS) words, or rated
// short or vague by at least one rater (evidence for a human, so a lower bar
// than THIN_REVIEWS' PCS_THRESH_RATING_RATERS; reasons quote the counts).
// Sorted by pid, then email. "Rated short/vague" in the accountability rows
// counts reviews with at least one such flag.
//
// Withhold draft (PCS_POLICY_WITHHOLD_REVIEWS): for each reserve reviewer with
// a late review (any escalation state, replaced included: the review is still
// owed), their own undecided papers. Drafted as a HotCRP bulk-assignment CSV
// that tags those papers PCS_WITHHOLD_TAG, plus a search. Never applied.
//
// Participation by tier (spec §10.4 F): M4's reviewer metrics (participation
// since DISCUSSION_OPEN) summed per tier, plus published non-response
// comments by the tier's reviewers on papers they review, up to now (useful
// before discussion opens).

import { formatRatings, THIN_FLAGS } from "../../ratings.js";
import type { TierProgressPolicy } from "../../config.js";
import type { RuleContext } from "../../rules/context.js";
import { isSubmitted, type SnapshotIndex } from "../../rules/facts.js";
import { DEFAULT_TIER, type Millis, type ReviewView } from "../../rules/model.js";
import { DAY_MS, discussionOpened } from "../../rules/phase.js";
import type { ReviewerMetrics } from "../../rules/reviewer-metrics.js";
import {
  DROPOUT_STATES,
  type AccountabilityRow,
  type CoachingRow,
  type DropoutRow,
  type DropoutState,
  type LateReview,
  type OwnPaper,
  type ParticipationRow,
  type TierPerson,
  type TierProgressReport,
  type TierRow,
  type WithholdRow,
} from "./types.js";

export interface TierProgressInput {
  index: SnapshotIndex;
  /** Author email -> pids they author (live papers). */
  authored: ReadonlyMap<string, readonly number[]>;
  /** Reviews whose first_seen_at is a best guess (present at the first sync). */
  approxRids: ReadonlySet<number>;
  /** M4's per-reviewer metrics for the same snapshot and context. */
  reviewers: readonly ReviewerMetrics[];
  /** Tier display order: "senior" + PCS_TIER_TAGS tiers; others seen are appended. */
  tierOrder: readonly string[];
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const fmtDays = (d: number) => d.toFixed(1);

interface ReviewFacts {
  r: ReviewView;
  tier: string;
  submitted: boolean;
  outstanding: boolean;
  late: boolean;
  submittedLate: boolean;
  assignedAfterDue: boolean;
}

/** When a review was first seen in a submitted status. */
export function submittedAt(r: ReviewView): Millis | null {
  for (const v of r.versions) if (isSubmitted(v)) return v.seenAt;
  return r.firstCompleteSeenAt ?? (isSubmitted(r) ? r.modifiedAt : null);
}

export function hotcrpReviewPath(r: Pick<ReviewView, "pid" | "rid" | "ordinal">): string {
  return r.ordinal ? `/review/${r.pid}${r.ordinal}` : `/review?p=${r.pid}&r=${r.rid}`;
}

export function computeTierProgress(input: TierProgressInput, ctx: RuleContext, policy: TierProgressPolicy): TierProgressReport {
  const { index } = input;
  const now = ctx.now;
  const due = ctx.phases.reviewDue;
  const deadlinePassed = now > due;
  const lateDays = deadlinePassed ? (now - due) / DAY_MS : 0;
  const reserve = new Set(policy.reserveTiers);
  const coach = new Set(policy.coachTiers);
  const chairs = new Set([...index.people.values()].filter((p) => p.roles.includes("chair")).map((p) => p.email));
  const person = (email: string): TierPerson => {
    const p = index.people.get(email);
    return { email, name: p?.name ?? email, tier: p?.tier ?? DEFAULT_TIER };
  };

  const byTier = new Map<string, { emails: Set<string>; lateEmails: Set<string>; row: Omit<TierRow, "tier" | "reviewers" | "latePeople" | "reason"> }>();
  const tierBucket = (tier: string) => {
    let b = byTier.get(tier);
    if (!b) {
      b = { emails: new Set(), lateEmails: new Set(), row: { assigned: 0, submitted: 0, outstanding: 0, late: 0, submittedLate: 0, assignedAfterDue: 0 } };
      byTier.set(tier, b);
    }
    return b;
  };

  const late: LateReview[] = [];
  const dropout: DropoutRow[] = [];
  const coaching: CoachingRow[] = [];
  const perPerson = new Map<string, ReviewFacts[]>();
  const commentsByTier = new Map<string, { comments: number; commenters: Set<string> }>();

  for (const b of index.bundles) {
    const acs = new Set(b.acs);
    const decided = b.paper.decision !== null;
    const reviewerReviews = b.reviews.filter((r) => r.rtype !== 5 && !acs.has(r.email));
    const reviewerEmails = new Set(reviewerReviews.map((r) => r.email));
    const addedAfterDue = (r: ReviewView) => !input.approxRids.has(r.rid) && r.firstSeenAt > due && r.firstSeenAt <= now;

    for (const r of reviewerReviews) {
      const tier = person(r.email).tier;
      const submitted = isSubmitted(r);
      const assignedAfterDue = addedAfterDue(r);
      const outstanding = !submitted && !decided;
      const isLate = outstanding && deadlinePassed && !assignedAfterDue;
      const at = submitted ? submittedAt(r) : null;
      const f: ReviewFacts = {
        r,
        tier,
        submitted,
        outstanding,
        late: isLate,
        submittedLate: submitted && !assignedAfterDue && at !== null && at > due,
        assignedAfterDue: outstanding && assignedAfterDue,
      };
      const bucket = tierBucket(tier);
      bucket.emails.add(r.email);
      bucket.row.assigned++;
      if (submitted) bucket.row.submitted++;
      if (outstanding) bucket.row.outstanding++;
      if (f.late) {
        bucket.row.late++;
        bucket.lateEmails.add(r.email);
      }
      if (f.submittedLate) bucket.row.submittedLate++;
      if (f.assignedAfterDue) bucket.row.assignedAfterDue++;
      let list = perPerson.get(r.email);
      if (!list) perPerson.set(r.email, (list = []));
      list.push(f);

      if (f.late) {
        late.push({ pid: b.paper.pid, rid: r.rid, person: person(r.email), lateDays });
        if (reserve.has(tier)) {
          const ping = b.comments.find(
            (c) =>
              !c.draft &&
              !c.isResponse &&
              c.time >= due &&
              c.time <= now &&
              c.email !== r.email &&
              (acs.has(c.email) || chairs.has(c.email)) &&
              c.mentions.includes(r.email),
          );
          const replacedBy = [...new Set(reviewerReviews.filter((o) => o.email !== r.email && addedAfterDue(o)).map((o) => o.email))].sort();
          let state: DropoutState;
          let reason: string;
          const lateTxt = `${fmtDays(lateDays)} days after the review deadline`;
          if (replacedBy.length > 0) {
            state = "replaced";
            reason = `not submitted ${lateTxt}; ${plural(replacedBy.length, "reviewer")} added on #${b.paper.pid} since the deadline (${replacedBy.join(", ")})`;
          } else if (lateDays > policy.dropoutDays) {
            state = "replacement-needed";
            reason = `not submitted ${lateTxt}, more than PCS_RESERVE_DROPOUT_DAYS=${policy.dropoutDays}; no reviewer added since the deadline`;
          } else if (ping) {
            state = "pinged";
            const ago = (now - ping.time) / DAY_MS;
            reason = `not submitted ${lateTxt}; @mentioned by ${ping.email} ${fmtDays(ago)} days ago (within PCS_RESERVE_DROPOUT_DAYS=${policy.dropoutDays})`;
          } else {
            state = "late";
            reason = `not submitted ${lateTxt}; no AC or chair @mention since the deadline (within PCS_RESERVE_DROPOUT_DAYS=${policy.dropoutDays})`;
          }
          dropout.push({
            pid: b.paper.pid,
            rid: r.rid,
            title: b.paper.title,
            person: person(r.email),
            lateDays,
            state,
            pingedAt: ping?.time ?? null,
            pingedBy: ping?.email ?? null,
            replacedBy,
            reason,
          });
        }
      }

      if (coach.has(tier) && submitted) {
        const underFloor = r.wordCount < policy.coachMinWords;
        const ratedShort = (r.ratings.short ?? 0) > 0;
        const ratedVague = (r.ratings.vague ?? 0) > 0;
        if (underFloor || ratedShort || ratedVague) {
          const flags = formatRatings(r.ratings, THIN_FLAGS);
          const why = [
            ...(underFloor ? [`${r.wordCount} words, under the coaching floor of ${policy.coachMinWords}`] : [`${r.wordCount} words`]),
            ...(flags ? [`rated ${flags}`] : []),
          ];
          coaching.push({
            pid: b.paper.pid,
            rid: r.rid,
            ordinal: r.ordinal,
            person: person(r.email),
            words: r.wordCount,
            underFloor,
            ratedShort,
            ratedVague,
            reason: why.join("; "),
            hotcrpPath: hotcrpReviewPath(r),
          });
        }
      }
    }

    for (const c of b.comments) {
      if (c.draft || c.isResponse || c.time > now || !reviewerEmails.has(c.email)) continue;
      const tier = person(c.email).tier;
      let t = commentsByTier.get(tier);
      if (!t) commentsByTier.set(tier, (t = { comments: 0, commenters: new Set() }));
      t.comments++;
      t.commenters.add(c.email);
    }
  }

  // Tier order: configured first (empty groups included), then any other seen.
  const tierNames = [...input.tierOrder];
  for (const t of [...byTier.keys()].sort()) if (!tierNames.includes(t)) tierNames.push(t);

  const tiers: TierRow[] = tierNames.map((tier) => {
    const b = byTier.get(tier);
    const row = b?.row ?? { assigned: 0, submitted: 0, outstanding: 0, late: 0, submittedLate: 0, assignedAfterDue: 0 };
    const reviewers = b?.emails.size ?? 0;
    const latePeople = b?.lateEmails.size ?? 0;
    const parts = [
      `${row.submitted} of ${row.assigned} submitted`,
      `${row.outstanding} outstanding`,
      deadlinePassed ? `${row.late} late (${plural(latePeople, "reviewer")}, deadline passed ${fmtDays(lateDays)} days ago)` : "deadline not passed yet",
      ...(row.submittedLate > 0 ? [`${row.submittedLate} submitted after the deadline`] : []),
      ...(row.assignedAfterDue > 0 ? [`${row.assignedAfterDue} assigned after the deadline`] : []),
    ];
    return { tier, reviewers, latePeople, ...row, reason: parts.join("; ") };
  });

  // Accountability.
  const papers = new Map(index.bundles.map((b) => [b.paper.pid, b.paper]));
  const ownPapers = (email: string): OwnPaper[] =>
    (input.authored.get(email) ?? [])
      .filter((pid) => papers.has(pid))
      .map((pid) => ({ pid, title: papers.get(pid)!.title, decision: papers.get(pid)!.decision }));
  const accountability: AccountabilityRow[] = [];
  for (const [email, fs] of [...perPerson.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const p = person(email);
    if (!reserve.has(p.tier)) continue;
    const thin = fs.filter((f) => f.submitted && f.r.wordCount < ctx.thresholds.MIN_WORDS);
    const lateNow = fs.filter((f) => f.late);
    const subLate = fs.filter((f) => f.submittedLate);
    const own = ownPapers(email);
    const row: AccountabilityRow = {
      person: p,
      ownPapers: own,
      assigned: fs.length,
      submitted: fs.filter((f) => f.submitted).length,
      lateOutstanding: lateNow.length,
      submittedLate: subLate.length,
      thin: thin.length,
      ratedShort: fs.filter((f) => (f.r.ratings.short ?? 0) > 0).length,
      ratedVague: fs.filter((f) => (f.r.ratings.vague ?? 0) > 0).length,
      reviewPids: fs.map((f) => f.r.pid),
      latePids: [...lateNow, ...subLate].map((f) => f.r.pid).sort((a, b) => a - b),
      thinPids: thin.map((f) => f.r.pid),
      summary: "",
    };
    row.summary =
      `authors ${own.length > 0 ? own.map((o) => `#${o.pid}`).join(" ") : "no paper in the store"}; ` +
      `reviews: ${row.submitted} of ${row.assigned} submitted, ${row.lateOutstanding} late and outstanding, ` +
      `${row.submittedLate} submitted after the deadline, ${row.thin} under ${ctx.thresholds.MIN_WORDS} words, ` +
      `${row.ratedShort} rated short, ${row.ratedVague} rated vague`;
    accountability.push(row);
  }

  // Withhold draft.
  const withholdRows: WithholdRow[] = [];
  if (policy.withholdReviews) {
    const lateByPerson = new Map<string, number[]>();
    for (const d of dropout) lateByPerson.set(d.person.email, [...(lateByPerson.get(d.person.email) ?? []), d.pid]);
    for (const [email, latePids] of [...lateByPerson.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const own = ownPapers(email).filter((o) => o.decision === null);
      withholdRows.push({
        person: person(email),
        latePids: latePids.sort((a, b) => a - b),
        withheldPids: own.map((o) => o.pid),
        reason:
          `${plural(latePids.length, "reserve review")} late (${latePids.map((p) => `#${p}`).join(" ")}); ` +
          (own.length > 0 ? `own undecided ${own.length === 1 ? "paper" : "papers"} ${own.map((o) => `#${o.pid}`).join(" ")}` : "no undecided paper of their own in the store"),
      });
    }
  }
  const withheld = [...new Set(withholdRows.flatMap((w) => w.withheldPids))].sort((a, b) => a - b);
  const withhold = {
    enabled: policy.withholdReviews,
    tag: policy.withholdTag,
    rows: withholdRows,
    csv: withheld.length > 0 ? `paper,action,tag\n${withheld.map((pid) => `${pid},tag,${policy.withholdTag}`).join("\n")}\n` : "",
    search: withheld.length > 0 ? withheld.join(" ") : "",
    note: policy.withholdReviews
      ? `Draft only: PC Supervisor never applies it. To adopt it, upload the CSV in HotCRP (Assignments > Bulk update), check the preview, then hide reviews from authors of papers tagged #${policy.withholdTag} in HotCRP's settings or by hand. Remove the tag once the reserve review is in.`
      : "PCS_POLICY_WITHHOLD_REVIEWS is off; nothing is drafted.",
  };

  // Participation by tier (M4 metrics + comment counts).
  const opened = discussionOpened(ctx.phases, now);
  const participation: ParticipationRow[] = tierNames.map((tier) => {
    const ms = input.reviewers.filter((m) => m.tier === tier);
    const papersN = ms.reduce((n, m) => n + m.participation.papers, 0);
    const commented = ms.reduce((n, m) => n + m.participation.commented, 0);
    const c = commentsByTier.get(tier);
    const share = opened && papersN > 0 ? commented / papersN : null;
    const commenters = c?.commenters.size ?? 0;
    return {
      tier,
      reviewers: ms.length,
      commenters,
      comments: c?.comments ?? 0,
      discussionPapers: papersN,
      discussionCommented: commented,
      share,
      reason:
        `${commenters} of ${ms.length} reviewers have commented (${plural(c?.comments ?? 0, "comment")} on papers they review)` +
        (opened ? `; since discussion opened, a comment on ${commented} of ${plural(papersN, "paper")}` : "; discussion has not opened yet"),
    };
  });

  const counts = Object.fromEntries(DROPOUT_STATES.map((s) => [s, dropout.filter((d) => d.state === s).length])) as Record<DropoutState, number>;
  const byPidEmail = <T extends { pid: number; person: TierPerson }>(a: T, b: T) => a.pid - b.pid || a.person.email.localeCompare(b.person.email);
  return {
    now,
    reviewDue: due,
    deadlinePassed,
    tiers,
    late: late.sort(byPidEmail),
    dropout: { reserveTiers: [...policy.reserveTiers], dropoutDays: policy.dropoutDays, counts, rows: dropout.sort(byPidEmail) },
    accountability: {
      note: "Evidence for a human decision about consequences. PC Supervisor makes no decision and applies nothing.",
      rows: accountability,
    },
    coaching: { tiers: [...policy.coachTiers], minWords: policy.coachMinWords, rows: coaching.sort(byPidEmail) },
    withhold,
    participation: { discussionOpened: opened, rows: participation },
  };
}
