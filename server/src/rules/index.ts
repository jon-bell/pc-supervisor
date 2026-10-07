// Public surface of the rules engine (spec §5). Import from "@pcs/server/rules/index".

export * from "./model.js";
export * from "./phase.js";
export * from "./context.js";
export * from "./facts.js";
export * from "./rules.js";
export * from "./evaluate.js";
export * from "./ac-metrics.js";
export * from "./reviewer-metrics.js";
export * from "./burndown.js";

import type { RuleContext } from "./context.js";
import { computeAcMetrics, type AcMetrics } from "./ac-metrics.js";
import { computeBurndown, type BurndownPoint } from "./burndown.js";
import { evaluateAll, type Evaluation } from "./evaluate.js";
import type { SnapshotView } from "./model.js";
import { phaseAt, type PhaseName } from "./phase.js";
import { computeOutliers, computeReviewerMetrics, type Outliers, type ReviewerMetrics } from "./reviewer-metrics.js";

export interface Analysis {
  phase: PhaseName;
  evaluation: Evaluation;
  acs: AcMetrics[];
  reviewers: ReviewerMetrics[];
  outliers: Outliers;
  burndown: BurndownPoint[];
}

/** Everything the UI needs, in one O(rows) pass family. */
export function analyze(snapshot: SnapshotView, ctx: RuleContext): Analysis {
  const evaluation = evaluateAll(snapshot, ctx);
  const reviewers = computeReviewerMetrics(evaluation, ctx);
  return {
    phase: phaseAt(ctx.phases, ctx.now),
    evaluation,
    acs: computeAcMetrics(evaluation, ctx),
    reviewers,
    outliers: computeOutliers(reviewers),
    burndown: computeBurndown(evaluation.facts.values(), ctx),
  };
}
