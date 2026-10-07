// A §10.4 module's activation status for its view (PLAN M11): the current
// extended phase, the phases the module is active in (MODULE_PHASES, M9),
// and the time window those phases span under the configured dates.

import { MODULE_PHASES, MODULES, extendedPhaseAt, type ExtendedPhaseName, type ModuleId, type PhaseTimes } from "../rules/phase.js";
import type { Millis } from "../rules/model.js";

export interface PhaseInterval {
  /** Start (just after the previous deadline for chained phases), or null = from the beginning. */
  from: Millis | null;
  /** Inclusive end (the phase's own deadline), or null = open-ended. */
  to: Millis | null;
}

export interface ModuleStatus {
  id: ModuleId;
  letter: string;
  title: string;
  phase: ExtendedPhaseName;
  active: boolean;
  activeIn: readonly ExtendedPhaseName[];
  /** The span of the module's phases that exist under the configured dates; null if none does. */
  window: PhaseInterval | null;
}

const set = (t: Millis | null | undefined): t is Millis => t !== null && t !== undefined;

/** Each extended phase's interval, or null when the configured dates give it no time. */
export function phaseIntervals(p: PhaseTimes): Record<ExtendedPhaseName, PhaseInterval | null> {
  const out = {} as Record<ExtendedPhaseName, PhaseInterval | null>;
  let prev: Millis | null = null;
  for (const [due, name] of [
    [p.registrationDue, "registration"],
    [p.submissionDue, "submission"],
    [p.quickRejectDue, "quick-reject"],
    [p.assignmentDone, "assignment"],
  ] as const) {
    if (set(due)) {
      out[name] = { from: prev, to: due };
      prev = due;
    } else out[name] = null;
  }
  out["before-review-due"] = { from: prev, to: p.reviewDue };
  const respOk = p.responseOpen !== null && p.responseClose !== null;
  const er = set(p.earlyRejectOpen) && set(p.earlyRejectClose) ? { from: p.earlyRejectOpen, to: p.earlyRejectClose } : null;
  out["early-reject"] = er;
  out["reviewing-late"] = { from: er ? er.to : p.reviewDue, to: respOk ? p.responseOpen! : p.discussionOpen };
  out.response = respOk ? { from: p.responseOpen!, to: p.responseClose! } : null;
  out.discussion = { from: p.discussionOpen, to: p.discussionClose };
  out.decisions = { from: p.discussionClose, to: p.decisionsDue };
  out["after-decisions"] = { from: p.decisionsDue, to: null };
  return out;
}

export function moduleStatus(id: ModuleId, p: PhaseTimes, now: Millis): ModuleStatus {
  const phase = extendedPhaseAt(p, now);
  const activeIn = MODULE_PHASES[id];
  const iv = phaseIntervals(p);
  const spans = activeIn.map((ph) => iv[ph]).filter((x): x is PhaseInterval => x !== null);
  const window = spans.length
    ? {
        from: spans.some((s) => s.from === null) ? null : Math.min(...spans.map((s) => s.from!)),
        to: spans.some((s) => s.to === null) ? null : Math.max(...spans.map((s) => s.to!)),
      }
    : null;
  return { id, ...MODULES[id], phase, active: activeIn.includes(phase), activeIn, window };
}

/** One line for the CLI, e.g. "Module A (Reserve-reviewer compliance): active now (phase registration) ...". */
export function describeModuleStatus(s: ModuleStatus, fmt: (t: Millis) => string): string {
  const w = s.window;
  const span = !w
    ? `no window: none of its phases (${s.activeIn.join(", ")}) has a configured date`
    : `window ${w.from === null ? "(start)" : fmt(w.from)} .. ${w.to === null ? "(open)" : fmt(w.to)}`;
  return `Module ${s.letter} (${s.title}): ${s.active ? "active now" : "not active now"} (phase ${s.phase}); ${span}`;
}

