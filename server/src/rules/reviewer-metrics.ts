// Per-reviewer engagement (spec §5a) and the outlier lists. A "reviewer" row
// covers a person's reviewer (non-AC) assignments only; the same person's AC
// work is in ac-metrics.ts. O(rows): each paper is visited once per reviewer.
//
// Definitions:
// - assigned / submitted: reviewer reviews on any paper / in SUBMITTED_STATUSES.
// - outstanding:  pids of assigned reviews not submitted. `late` once
//                 REVIEW_DUE has passed and something is outstanding.
// - depth:        median words over their submitted reviews vs the PC median
//                 (all submitted reviewer reviews). `bottomDecile` counts their
//                 reviews strictly below the PC's 10th percentile (nearest
//                 rank); `thin` counts reviews under PCS_THRESH_MIN_WORDS;
//                 `ratedShort` / `ratedVague` count rating flags.
// - participation: once discussion opens, over their assigned papers: how
//                 many have a published comment from them since DISCUSSION_OPEN.
// - responsiveness: a ping is a published non-response comment by someone
//                 else on a paper they review that @mentions them or is by
//                 one of that paper's ACs. Pings that arrive before they reply
//                 merge into one episode (starting at the first ping); their
//                 next comment on the paper answers it. `medianDays` is the
//                 median reply delay over answered episodes. `unanswered`
//                 lists open episodes older than PCS_THRESH_PING_DAYS, one per
//                 undecided paper, with the first @mention time if any; `open`
//                 lists every open episode on an undecided paper, whatever its
//                 age (the person page's "open pings").
// - movement:     their reviews with a merit or expertise change seen at or
//                 after DISCUSSION_OPEN.
// - silentOnSplit: undecided SPLIT papers (rules.ts splitOf) they review,
//                 with no comment from them since DISCUSSION_OPEN; only once
//                 discussion has opened.
//
// Outliers (no leaderboard, spec §2): a person appears in a list only when
// they cross that list's bar, which is an absolute count, never a rank:
//   silentOnSplit  >= 1 silent split paper
//   unansweredPings >= 1 ping older than PCS_THRESH_PING_DAYS
//   late           >= 1 outstanding review after REVIEW_DUE
//   thin           >= 1 review that is thin, rated short/vague, or in the
//                  PC's bottom decile (count = such reviews)
// Within a list, entries are ordered by that count (so "who's furthest over
// the bar" is first), then by email. Lists are split by tier.

import type { RuleContext } from "./context.js";
import type { Evaluation } from "./evaluate.js";
import { isSubmitted, median, movesSince, percentile, type PaperFacts } from "./facts.js";
import { DEFAULT_TIER, type Millis, type Tier } from "./model.js";
import { DAY_MS, discussionOpened, reviewsDuePassed } from "./phase.js";
import { splitOf } from "./rules.js";

export interface UnansweredPing {
  pid: number;
  /** First ping of the open episode. */
  since: Millis;
  ageDays: number;
  pings: number;
  /** First @mention within the episode, or null if only AC comments. */
  mentionedAt: Millis | null;
}

export interface ReviewerMetrics {
  email: string;
  name: string;
  tier: Tier;
  pids: readonly number[];
  assigned: number;
  submitted: number;
  outstanding: readonly number[];
  late: boolean;
  depth: {
    medianWords: number | null;
    pcMedianWords: number | null;
    bottomDecile: number;
    thin: number;
    ratedShort: number;
    ratedVague: number;
    /** Papers with a thin, bottom-decile, or short/vague-rated review of theirs. */
    flaggedPids: readonly number[];
  };
  participation: { papers: number; commented: number; share: number | null };
  responsiveness: {
    medianDays: number | null;
    answered: number;
    unanswered: readonly UnansweredPing[];
    /** Every open episode on an undecided paper, any age (unanswered is the subset over PCS_THRESH_PING_DAYS). */
    open: readonly UnansweredPing[];
  };
  movement: { reviews: number; pids: readonly number[] };
  silentOnSplit: readonly number[];
}

interface PaperRole {
  f: PaperFacts;
  split: boolean;
}

function pingsOn(f: PaperFacts, email: string, ctx: RuleContext) {
  let start: Millis | null = null;
  let mentionedAt: Millis | null = null;
  let count = 0;
  const delays: number[] = [];
  for (const c of f.pcComments) {
    if (c.time > ctx.now) break;
    if (c.email === email) {
      if (start !== null) delays.push((c.time - start) / DAY_MS);
      start = null;
      mentionedAt = null;
      count = 0;
      continue;
    }
    const mention = c.mentions.includes(email);
    if (!mention && !f.acSet.has(c.email)) continue;
    if (start === null) start = c.time;
    if (mention && mentionedAt === null) mentionedAt = c.time;
    count++;
  }
  const episode: UnansweredPing | null =
    start !== null ? { pid: f.pid, since: start, ageDays: (ctx.now - start) / DAY_MS, pings: count, mentionedAt } : null;
  const open = episode !== null && episode.ageDays > ctx.thresholds.PING_DAYS ? episode : null;
  return { delays, open, episode };
}

export function computeReviewerMetrics(ev: Evaluation, ctx: RuleContext): ReviewerMetrics[] {
  const opened = discussionOpened(ctx.phases, ctx.now);
  const roles = new Map<string, PaperRole[]>();
  const allWords: number[] = [];
  for (const f of ev.facts.values()) {
    const split = !f.decided && splitOf(f.merits, ctx) !== null;
    const seen = new Set<string>();
    for (const r of f.reviewerReviews) {
      if (isSubmitted(r)) allWords.push(r.wordCount);
      if (seen.has(r.email)) continue;
      seen.add(r.email);
      let a = roles.get(r.email);
      if (!a) roles.set(r.email, (a = []));
      a.push({ f, split });
    }
  }
  const pcMedian = median(allWords);
  const p10 = percentile(allWords, 10);

  const out: ReviewerMetrics[] = [];
  for (const [email, papers] of roles) {
    const person = ev.index.people.get(email);
    const words: number[] = [];
    const outstanding: number[] = [];
    const moved: number[] = [];
    const silentOnSplit: number[] = [];
    const delays: number[] = [];
    const thinPids: number[] = [];
    const unanswered: UnansweredPing[] = [];
    const openPings: UnansweredPing[] = [];
    let assigned = 0;
    let submitted = 0;
    let bottomDecile = 0;
    let thin = 0;
    let ratedShort = 0;
    let ratedVague = 0;
    let commented = 0;

    for (const { f, split } of papers) {
      let movedHere = false;
      for (const r of f.reviewerReviews) {
        if (r.email !== email) continue;
        assigned++;
        if (isSubmitted(r)) {
          submitted++;
          words.push(r.wordCount);
          const low = p10 !== null && r.wordCount < p10;
          const short = r.wordCount < ctx.thresholds.MIN_WORDS;
          if (low) bottomDecile++;
          if (short) thin++;
          if (r.ratedShort) ratedShort++;
          if (r.ratedVague) ratedVague++;
          if (low || short || r.ratedShort || r.ratedVague) thinPids.push(f.pid);
        } else {
          outstanding.push(f.pid);
        }
        const since = ctx.phases.discussionOpen;
        if (movesSince(r, since, "merit").length > 0 || movesSince(r, since, "expertise").length > 0) movedHere = true;
      }
      if (movedHere) moved.push(f.pid);
      const spoke = f.discussionCommenters.has(email);
      if (opened && spoke) commented++;
      if (opened && split && !spoke) silentOnSplit.push(f.pid);
      const p = pingsOn(f, email, ctx);
      delays.push(...p.delays);
      if (p.open && !f.decided) unanswered.push(p.open);
      if (p.episode && !f.decided) openPings.push(p.episode);
    }

    out.push({
      email,
      name: person?.name ?? email,
      tier: person?.tier ?? DEFAULT_TIER,
      pids: papers.map((p) => p.f.pid),
      assigned,
      submitted,
      outstanding,
      late: outstanding.length > 0 && reviewsDuePassed(ctx.phases, ctx.now),
      depth: { medianWords: median(words), pcMedianWords: pcMedian, bottomDecile, thin, ratedShort, ratedVague, flaggedPids: thinPids },
      participation: {
        papers: opened ? papers.length : 0,
        commented,
        share: opened && papers.length > 0 ? commented / papers.length : null,
      },
      responsiveness: { medianDays: median(delays), answered: delays.length, unanswered, open: openPings },
      movement: { reviews: moved.length, pids: moved },
      silentOnSplit,
    });
  }
  return out.sort((x, y) => x.email.localeCompare(y.email));
}

// ---------------------------------------------------------------------------
// Outlier lists

export type OutlierList = "silentOnSplit" | "unansweredPings" | "late" | "thin";

export interface OutlierEntry {
  email: string;
  name: string;
  tier: Tier;
  /** The count compared against the list's bar. */
  count: number;
  pids: readonly number[];
  detail: string;
}

/** List -> tier -> entries. Tiers with no entries are omitted. */
export type Outliers = Record<OutlierList, Record<Tier, OutlierEntry[]>>;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function entryFor(list: OutlierList, m: ReviewerMetrics): Omit<OutlierEntry, "email" | "name" | "tier"> | null {
  switch (list) {
    case "silentOnSplit": {
      const n = m.silentOnSplit.length;
      return n === 0 ? null : { count: n, pids: m.silentOnSplit, detail: `no comments yet on ${plural(n, "split paper")}` };
    }
    case "unansweredPings": {
      const u = m.responsiveness.unanswered;
      if (u.length === 0) return null;
      const oldest = Math.max(...u.map((p) => p.ageDays));
      return {
        count: u.length,
        pids: u.map((p) => p.pid),
        detail: `${plural(u.length, "paper")} with an unanswered ping; oldest ${oldest.toFixed(1)} days`,
      };
    }
    case "late": {
      const n = m.outstanding.length;
      return !m.late ? null : { count: n, pids: m.outstanding, detail: `${plural(n, "review")} not submitted after the deadline` };
    }
    case "thin": {
      const d = m.depth;
      const n = d.flaggedPids.length;
      if (n === 0) return null;
      const parts = [
        ...(d.thin > 0 ? [`${d.thin} under the word minimum`] : []),
        ...(d.bottomDecile > 0 ? [`${d.bottomDecile} in the PC's bottom decile`] : []),
        ...(d.ratedShort > 0 ? [`${d.ratedShort} rated short`] : []),
        ...(d.ratedVague > 0 ? [`${d.ratedVague} rated vague`] : []),
      ];
      return { count: n, pids: d.flaggedPids, detail: `${parts.join(", ")}; median ${d.medianWords} words vs PC ${d.pcMedianWords}` };
    }
  }
}

export const OUTLIER_LISTS: readonly OutlierList[] = ["silentOnSplit", "unansweredPings", "late", "thin"];

export function computeOutliers(metrics: readonly ReviewerMetrics[]): Outliers {
  const out = Object.fromEntries(OUTLIER_LISTS.map((l) => [l, {}])) as Outliers;
  for (const list of OUTLIER_LISTS) {
    const byTier = out[list];
    for (const m of metrics) {
      const e = entryFor(list, m);
      if (!e) continue;
      (byTier[m.tier] ??= []).push({ email: m.email, name: m.name, tier: m.tier, ...e });
    }
    for (const entries of Object.values(byTier)) {
      entries.sort((a, b) => b.count - a.count || a.email.localeCompare(b.email));
    }
  }
  return out;
}
