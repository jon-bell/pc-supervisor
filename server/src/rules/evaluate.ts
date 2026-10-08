// (snapshot view, context) -> per-paper reasons + severity (spec §5c).
//
// - Severity is the sum of the weights of the rules that fired.
// - A rule whose weight is 0 is disabled: it is not evaluated or reported.
// - A paper with a decision fires nothing: once the chair has decided, the
//   paper has left triage (golden pid 1). The exception is REVIEW_FLAGGED
//   (DECISION_INDEPENDENT): a disrespectful or wrong review needs chair action
//   before authors see it, and they see it with the decision.
// - ctx.ratingsEnabled comes from the snapshot (SnapshotView.ratingsEnabled).
// - Order: severity descending, then time to DECISIONS_DUE ascending, then
//   pid. With one global DECISIONS_DUE (the single-cycle phase model) the
//   second key ties for every paper, so ties fall through to pid; it is kept
//   so per-paper deadlines (two-cycle, spec §10.1) slot in without a change.

import { RULE_NAMES, type RuleName } from "../config.js";
import type { RuleContext } from "./context.js";

/** The context with ratingsEnabled from the data (unchanged object when it already agrees). */
export function withRatings(ctx: RuleContext, enabled: boolean): RuleContext {
  return (ctx.ratingsEnabled !== false) === enabled ? ctx : { ...ctx, ratingsEnabled: enabled };
}
import { indexSnapshot, paperFacts, type PaperBundle, type PaperFacts, type SnapshotIndex } from "./facts.js";
import type { Millis, SnapshotView } from "./model.js";
import { RULES } from "./rules.js";

/** Rules that still fire once a paper has a decision (spec §5c). */
export const DECISION_INDEPENDENT: ReadonlySet<RuleName> = new Set<RuleName>(["REVIEW_FLAGGED"]);

export interface FiredRule {
  rule: RuleName;
  weight: number;
  reason: string;
}

export interface PaperResult {
  pid: number;
  severity: number;
  fired: readonly FiredRule[];
  /** Last in-HotCRP activity on the paper, for the triage list. */
  lastActivity: Millis | null;
  /** DECISIONS_DUE for this paper (the secondary sort key). */
  decisionsDue: Millis;
}

/** Evaluate one paper from its precomputed facts. */
export function evaluateFacts(f: PaperFacts, ctx: RuleContext): PaperResult {
  const fired: FiredRule[] = [];
  for (const rule of RULE_NAMES) {
    if (f.decided && !DECISION_INDEPENDENT.has(rule)) continue;
    const weight = ctx.weights[rule];
    if (weight === 0) continue;
    const reason = RULES[rule](f, ctx);
    if (reason !== null) fired.push({ rule, weight, reason });
  }
  return {
    pid: f.pid,
    severity: fired.reduce((s, r) => s + r.weight, 0),
    fired,
    lastActivity: f.lastActivity,
    decisionsDue: ctx.phases.decisionsDue,
  };
}

export function evaluatePaper(b: PaperBundle, ctx: RuleContext): PaperResult {
  return evaluateFacts(paperFacts(b, ctx), ctx);
}

export function compareResults(a: PaperResult, b: PaperResult): number {
  return b.severity - a.severity || a.decisionsDue - b.decisionsDue || a.pid - b.pid;
}

export interface Evaluation {
  index: SnapshotIndex;
  facts: ReadonlyMap<number, PaperFacts>;
  /** Every paper, sorted for triage (compareResults). */
  results: readonly PaperResult[];
  byPid: ReadonlyMap<number, PaperResult>;
}

/** Evaluate every paper in a snapshot (or an already-built index). */
export function evaluateAll(input: SnapshotView | SnapshotIndex, base: RuleContext): Evaluation {
  const index = "bundles" in input ? input : indexSnapshot(input);
  const ctx = withRatings(base, index.ratingsEnabled);
  const facts = new Map<number, PaperFacts>();
  const results: PaperResult[] = [];
  for (const b of index.bundles) {
    const f = paperFacts(b, ctx);
    facts.set(f.pid, f);
    results.push(evaluateFacts(f, ctx));
  }
  const byPid = new Map(results.map((r) => [r.pid, r]));
  results.sort(compareResults);
  return { index, facts, results, byPid };
}
