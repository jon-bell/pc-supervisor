// Everything a rule needs besides the paper: now, phase dates, and the
// env-derived knobs. Built once per evaluation from Config + Clock.

import type { Clock } from "../clock.js";
import type { Config, RuleName, ThresholdName } from "../config.js";
import type { Millis } from "./model.js";
import { phaseTimesFromConfig, type PhaseTimes } from "./phase.js";

export interface RuleContext {
  now: Millis;
  phases: PhaseTimes;
  weights: Readonly<Record<RuleName, number>>;
  thresholds: Readonly<Record<ThresholdName, number>>;
  /** PCS_MERIT_ACCEPT_MIN: lowest merit on the accept side. */
  meritAcceptMin: number;
  /** PCS_EXPERTISE_OK_MIN: lowest "knowledgeable" expertise. */
  expertiseOkMin: number;
  /** PCS_REVIEWS_REQUIRED. */
  reviewsRequired: number;
  /**
   * From the synced HotCRP settings, not config: false when the instance has
   * review ratings off, so rating clauses are skipped (spec §1). Absent =
   * enabled. evaluateAll() sets it from the snapshot.
   */
  ratingsEnabled?: boolean;
}

type ContextConfig = Pick<Config, "phases" | "rules" | "meritAcceptMin" | "expertiseOkMin" | "reviewsRequired">;

/** The rule context for a loaded config, at the clock's current instant. */
export function ruleContextFromConfig(cfg: ContextConfig, clock: Clock): RuleContext {
  return {
    now: clock.now().getTime(),
    phases: phaseTimesFromConfig(cfg.phases),
    weights: cfg.rules.weights,
    thresholds: cfg.rules.thresholds,
    meritAcceptMin: cfg.meritAcceptMin,
    expertiseOkMin: cfg.expertiseOkMin,
    reviewsRequired: cfg.reviewsRequired,
  };
}

/** True unless the snapshot said ratings are off. */
export const ratingsOn = (ctx: Pick<RuleContext, "ratingsEnabled">): boolean => ctx.ratingsEnabled !== false;

/** The same context at a different instant (burndown, tests). */
export function atInstant(ctx: RuleContext, now: Millis): RuleContext {
  return { ...ctx, now };
}
