// Everything a rule needs besides the paper: now, phase dates, and the rule
// settings (weights, switches, thresholds, score knobs). Built once per
// evaluation from Config + Clock + the chair's overrides (settings.ts).
//
// The app builds every context through effectiveRuleContext()
// (rule-settings/service.ts), which reads the overrides from the store; a
// unit test keeps other src/ callers of ruleContextFromConfig out.

import type { Clock } from "../clock.js";
import type { Config, RuleName, ThresholdName } from "../config.js";
import type { Millis } from "./model.js";
import { phaseTimesFromConfig, type PhaseTimes } from "./phase.js";
import { effectiveWeights, envSettings, overlay, type Overrides, type RuleSettings } from "./settings.js";

export interface RuleContext {
  now: Millis;
  phases: PhaseTimes;
  /** Effective weights: 0 for a disabled rule (settings.ts effectiveWeights). */
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

/** The rule context for given settings, at the clock's current instant. */
export function ruleContextFromSettings(s: RuleSettings, phases: ContextConfig["phases"], clock: Clock): RuleContext {
  return {
    now: clock.now().getTime(),
    phases: phaseTimesFromConfig(phases),
    weights: effectiveWeights(s),
    thresholds: s.thresholds,
    meritAcceptMin: s.meritAcceptMin,
    expertiseOkMin: s.expertiseOkMin,
    reviewsRequired: s.reviewsRequired,
  };
}

/** The rule context for a loaded config (env defaults, plus `overrides` if given), at the clock's current instant. */
export function ruleContextFromConfig(cfg: ContextConfig, clock: Clock, overrides: Overrides = {}): RuleContext {
  return ruleContextFromSettings(overlay(envSettings(cfg), overrides), cfg.phases, clock);
}

/** True unless the snapshot said ratings are off. */
export const ratingsOn = (ctx: Pick<RuleContext, "ratingsEnabled">): boolean => ctx.ratingsEnabled !== false;

/** The same context at a different instant (burndown, tests). */
export function atInstant(ctx: RuleContext, now: Millis): RuleContext {
  return { ...ctx, now };
}
