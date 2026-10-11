// Dry-run of a rule-settings change (spec §5c "Rule settings"): evaluate the
// same papers under the current and the proposed context and report what
// would change. Nothing is saved.
//
// Paper facts depend only on the data and the phase dates (facts.ts), not on
// weights or thresholds, so the proposed evaluation reuses the current
// Evaluation's facts and runs only the rule functions: O(papers x rules),
// no snapshot rebuild and no SQL.

import { RULE_NAMES, type RuleName } from "../config.js";
import type { RuleContext } from "./context.js";
import { evaluateFacts, withRatings, type Evaluation, type PaperResult } from "./evaluate.js";

export interface RuleCounts {
  /** Papers with severity > 0. */
  flagged: number;
  /** Papers firing each rule. */
  byRule: Record<RuleName, number>;
}

export interface PaperChange {
  pid: number;
  title: string;
  from: RuleName[];
  to: RuleName[];
  gained: RuleName[];
  lost: RuleName[];
  severityFrom: number;
  severityTo: number;
}

export interface RulePreview {
  papers: number;
  current: RuleCounts;
  proposed: RuleCounts;
  /** Papers that go from severity 0 to > 0, and back. */
  newlyFlagged: number;
  unflagged: number;
  /** Papers whose fired rules or severity change, newly flagged first, then by pid; at most `limit`. */
  changes: PaperChange[];
  changesTotal: number;
}

const zeroCounts = (): RuleCounts => ({ flagged: 0, byRule: Object.fromEntries(RULE_NAMES.map((r) => [r, 0])) as Record<RuleName, number> });

function count(c: RuleCounts, r: PaperResult): void {
  if (r.severity > 0) c.flagged++;
  for (const f of r.fired) c.byRule[f.rule]++;
}

/** Counts over a list of results. */
export function ruleCounts(results: Iterable<PaperResult>): RuleCounts {
  const c = zeroCounts();
  for (const r of results) count(c, r);
  return c;
}

const rank = (c: PaperChange) => (c.severityFrom === 0 && c.severityTo > 0 ? 0 : c.severityFrom > 0 && c.severityTo === 0 ? 1 : 2);

/**
 * `current` is the evaluation the app shows now (its contexts already carry
 * ratingsEnabled); `proposed` is the context to try.
 */
export function previewRules(current: Evaluation, proposed: RuleContext, o: { limit?: number } = {}): RulePreview {
  const ctx = withRatings(proposed, current.index.ratingsEnabled);
  const cur = zeroCounts();
  const next = zeroCounts();
  const changes: PaperChange[] = [];
  let newlyFlagged = 0;
  let unflagged = 0;
  for (const [pid, f] of current.facts) {
    const a = current.byPid.get(pid)!;
    const b = evaluateFacts(f, ctx);
    count(cur, a);
    count(next, b);
    const from = a.fired.map((x) => x.rule);
    const to = b.fired.map((x) => x.rule);
    if (a.severity === b.severity && from.length === to.length && from.every((r, i) => r === to[i])) continue;
    if (a.severity === 0 && b.severity > 0) newlyFlagged++;
    if (a.severity > 0 && b.severity === 0) unflagged++;
    changes.push({
      pid,
      title: f.bundle.paper.title,
      from,
      to,
      gained: to.filter((r) => !from.includes(r)),
      lost: from.filter((r) => !to.includes(r)),
      severityFrom: a.severity,
      severityTo: b.severity,
    });
  }
  changes.sort((x, y) => rank(x) - rank(y) || x.pid - y.pid);
  const limit = o.limit ?? 500;
  return {
    papers: current.facts.size,
    current: cur,
    proposed: next,
    newlyFlagged,
    unflagged,
    changes: changes.slice(0, limit),
    changesTotal: changes.length,
  };
}
