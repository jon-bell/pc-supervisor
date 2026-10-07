// GET /api/overview (spec §5c, Views): paper counts by stage, the score-spread
// histogram, flagged papers per AC, and the no-consensus burndown with the
// phase dates to draw it against. Everything comes from the cached analysis.
//
// Definitions:
// - counts: `reviewing` = undecided with fewer than PCS_REVIEWS_REQUIRED
//   submitted reviewer reviews; `discussing` = undecided with enough;
//   `decided`; `noConsensus` = undecided and split (rules.ts splitOf, as in
//   the burndown); `flagged` = severity > 0.
// - spread: every paper with >= 2 submitted reviewer merits, bucketed by
//   max - min; a bucket is `split` when range >= PCS_THRESH_SPLIT_RANGE.
//   (A paper can also be split with a smaller range when its scores straddle
//   PCS_MERIT_ACCEPT_MIN; the histogram shows range only.)

import type { FastifyInstance } from "fastify";
import { splitOf } from "../../rules/rules.js";
import type { OverviewResponse } from "../api-types.js";
import { personOf, type RouteDeps } from "../app.js";

const PHASE_DATES: readonly [key: string, label: string][] = [
  ["registrationDue", "Registration due"],
  ["submissionDue", "Submission due"],
  ["quickRejectDue", "Quick-reject due"],
  ["assignmentDone", "Assignment done"],
  ["reviewDue", "Reviews due"],
  ["earlyRejectOpen", "Early reject opens"],
  ["earlyRejectClose", "Early reject closes"],
  ["responseOpen", "Response opens"],
  ["responseClose", "Response closes"],
  ["discussionOpen", "Discussion opens"],
  ["discussionClose", "Discussion closes"],
  ["decisionsDue", "Decisions due"],
];

export function registerOverview(app: FastifyInstance, deps: RouteDeps): void {
  app.get("/api/overview", async (): Promise<OverviewResponse> => {
    const view = deps.analysis.get();
    const { analysis, ctx, people } = view;
    const ev = analysis.evaluation;

    const counts = { papers: 0, reviewing: 0, discussing: 0, decided: 0, noConsensus: 0, flagged: 0 };
    const spreadCount = new Map<number, number>();
    let spreadUnknown = 0;
    let maxRange = ctx.thresholds.SPLIT_RANGE;
    for (const f of ev.facts.values()) {
      counts.papers++;
      if ((ev.byPid.get(f.pid)?.severity ?? 0) > 0) counts.flagged++;
      if (f.decided) counts.decided++;
      else if (f.submitted.length < ctx.reviewsRequired) counts.reviewing++;
      else counts.discussing++;
      if (!f.decided && splitOf(f.merits, ctx)) counts.noConsensus++;
      if (f.merits.length < 2) {
        spreadUnknown++;
        continue;
      }
      const range = Math.max(...f.merits) - Math.min(...f.merits);
      spreadCount.set(range, (spreadCount.get(range) ?? 0) + 1);
      if (range > maxRange) maxRange = range;
    }
    const spread = Array.from({ length: maxRange + 1 }, (_, range) => ({
      range,
      papers: spreadCount.get(range) ?? 0,
      split: range >= ctx.thresholds.SPLIT_RANGE,
    }));

    const phaseRecord = ctx.phases as unknown as Record<string, number | null | undefined>;
    const phases = PHASE_DATES.flatMap(([key, label]) => {
      const at = phaseRecord[key];
      return typeof at === "number" ? [{ key, label, at }] : [];
    }).sort((a, b) => a.at - b.at);

    const flaggedPerAc = analysis.acs
      .map((a) => ({ person: personOf(people, a.email), load: a.load, flagged: a.flagged }))
      .sort((a, b) => a.person.name.localeCompare(b.person.name) || a.person.email.localeCompare(b.person.email));

    return {
      now: ctx.now,
      phase: analysis.phase,
      phases,
      counts,
      reviewsRequired: ctx.reviewsRequired,
      spread,
      splitRange: ctx.thresholds.SPLIT_RANGE,
      spreadUnknown,
      flaggedPerAc,
      burndown: analysis.burndown.map((p) => ({ t: p.t, undecided: p.undecided, noConsensus: p.noConsensus })),
    };
  });
}
