// Conference phase from the phase-date env vars and "now" (spec §4.1, §5).
// Pure: callers pass `now` from a Clock (clock.ts); nothing here reads time.
//
// Boundaries (a deadline instant belongs to the phase it ends):
//   now <= REVIEW_DUE                          before-review-due
//   REVIEW_DUE < now, before the next phase    reviewing-late
//   RESPONSE_OPEN <= now <= RESPONSE_CLOSE     response   (only if both set)
//   DISCUSSION_OPEN <= now <= DISCUSSION_CLOSE discussion
//   DISCUSSION_CLOSE < now <= DECISIONS_DUE    decisions
//   DECISIONS_DUE < now                        after-decisions
// "reviewing-late" also covers any gap between the response window and
// discussion (e.g. RESPONSE_CLOSE 23:59 .. DISCUSSION_OPEN 00:00).
//
// phaseAt() is the MVP model and ignores the extended dates. The extended
// model (spec §10.1, PLAN M9) is extendedPhaseAt(); it refines phaseAt() only
// where an extended date is configured, and is identical to it otherwise:
//   now <= REGISTRATION_DUE                    registration
//   .. <= SUBMISSION_DUE                       submission
//   .. <= QUICKREJECT_DUE                      quick-reject
//   .. <= ASSIGNMENT_DONE                      assignment
//   .. <= REVIEW_DUE                           before-review-due
//   EARLYREJECT_OPEN <= now <= EARLYREJECT_CLOSE early-reject (replaces reviewing-late)
//   later                                      as phaseAt()
// Each pre-review phase runs from the previous SET deadline (or the start of
// time) to its own deadline, so an unset date simply drops its phase.
// activeModules() maps a phase to the spec §10.4 modules A-G.

import type { Phases } from "../config.js";
import type { Millis } from "./model.js";

export const DAY_MS = 86_400_000;

export type PhaseName =
  | "before-review-due"
  | "reviewing-late"
  | "response"
  | "discussion"
  | "decisions"
  | "after-decisions";

/** Phase dates as epoch ms. Response dates are optional (set both or neither). */
export interface PhaseTimes {
  reviewDue: Millis;
  responseOpen: Millis | null;
  responseClose: Millis | null;
  discussionOpen: Millis;
  discussionClose: Millis;
  decisionsDue: Millis;
  // Extended phase model (spec §10.1); optional so MVP literals still type-check.
  registrationDue?: Millis | null;
  submissionDue?: Millis | null;
  quickRejectDue?: Millis | null;
  assignmentDone?: Millis | null;
  earlyRejectOpen?: Millis | null;
  earlyRejectClose?: Millis | null;
}

const ms = (d: Date | undefined): Millis | null => (d ? d.getTime() : null);

export function phaseTimesFromConfig(p: Phases): PhaseTimes {
  return {
    reviewDue: p.reviewDue.getTime(),
    responseOpen: p.responseOpen ? p.responseOpen.getTime() : null,
    responseClose: p.responseClose ? p.responseClose.getTime() : null,
    discussionOpen: p.discussionOpen.getTime(),
    discussionClose: p.discussionClose.getTime(),
    decisionsDue: p.decisionsDue.getTime(),
    registrationDue: ms(p.registrationDue),
    submissionDue: ms(p.submissionDue),
    quickRejectDue: ms(p.quickRejectDue),
    assignmentDone: ms(p.assignmentDone),
    earlyRejectOpen: ms(p.earlyRejectOpen),
    earlyRejectClose: ms(p.earlyRejectClose),
  };
}

export function phaseAt(p: PhaseTimes, now: Millis): PhaseName {
  if (now > p.decisionsDue) return "after-decisions";
  if (now > p.discussionClose) return "decisions";
  if (now >= p.discussionOpen) return "discussion";
  if (p.responseOpen !== null && p.responseClose !== null && now >= p.responseOpen && now <= p.responseClose) {
    return "response";
  }
  if (now > p.reviewDue) return "reviewing-late";
  return "before-review-due";
}

/** Fractional days from `from` to `to` (negative if `to` is earlier). */
export function daysBetween(from: Millis, to: Millis): number {
  return (to - from) / DAY_MS;
}

/** Fractional days since `t` at `now`. */
export function daysSince(t: Millis, now: Millis): number {
  return daysBetween(t, now);
}

/** Reviews are overdue: strictly after REVIEW_DUE. */
export function reviewsDuePassed(p: PhaseTimes, now: Millis): boolean {
  return now > p.reviewDue;
}

/** Discussion has opened (stays true through decisions and after). */
export function discussionOpened(p: PhaseTimes, now: Millis): boolean {
  return now >= p.discussionOpen;
}

/** Fractional days until DECISIONS_DUE (negative once it has passed). */
export function daysToDecisions(p: PhaseTimes, now: Millis): number {
  return daysBetween(now, p.decisionsDue);
}

// ---------------------------------------------------------------------------
// Extended phase model (spec §10.1) and module activation (spec §10.4).

export type ExtendedPhaseName =
  | "registration"
  | "submission"
  | "quick-reject"
  | "assignment"
  | PhaseName
  | "early-reject";

/** Every extended phase, in time order (reviewing-late can also follow early-reject). */
export const EXTENDED_PHASES: readonly ExtendedPhaseName[] = [
  "registration",
  "submission",
  "quick-reject",
  "assignment",
  "before-review-due",
  "reviewing-late",
  "early-reject",
  "response",
  "discussion",
  "decisions",
  "after-decisions",
];

const set = (t: Millis | null | undefined): t is Millis => t !== null && t !== undefined;

/**
 * The phase at `now`, recognizing the extended dates when configured (see the
 * header). With none configured this equals phaseAt(p, now).
 */
export function extendedPhaseAt(p: PhaseTimes, now: Millis): ExtendedPhaseName {
  if (now <= p.reviewDue) {
    const pre: [Millis | null | undefined, ExtendedPhaseName][] = [
      [p.registrationDue, "registration"],
      [p.submissionDue, "submission"],
      [p.quickRejectDue, "quick-reject"],
      [p.assignmentDone, "assignment"],
    ];
    for (const [due, name] of pre) if (set(due) && now <= due) return name;
    return "before-review-due";
  }
  const base = phaseAt(p, now);
  if (
    base === "reviewing-late" &&
    set(p.earlyRejectOpen) &&
    set(p.earlyRejectClose) &&
    now >= p.earlyRejectOpen &&
    now <= p.earlyRejectClose
  ) {
    return "early-reject";
  }
  return base;
}

/** The spec §10.4 modules. */
export type ModuleId =
  | "reserve-compliance" // A
  | "quick-reject" // B
  | "assignment-validator" // C
  | "reviewing-by-tier" // D
  | "early-reject" // E
  | "discussion" // F
  | "process-report"; // G

export const MODULES: Readonly<Record<ModuleId, { letter: string; title: string }>> = {
  "reserve-compliance": { letter: "A", title: "Reserve-reviewer compliance" },
  "quick-reject": { letter: "B", title: "Quick-reject / desk-reject tracker" },
  "assignment-validator": { letter: "C", title: "Assignment validator" },
  "reviewing-by-tier": { letter: "D", title: "Reviewing progress, by tier" },
  "early-reject": { letter: "E", title: "Early reject" },
  discussion: { letter: "F", title: "Discussion and decisions" },
  "process-report": { letter: "G", title: "Process report" },
};

/**
 * Which phases each module is active in (spec §10.4; the choices where the
 * spec is vague are documented there):
 * - A: around registration and submission, and through quick-reject while
 *   warnings are followed up.
 * - B: quick-reject, plus assignment for the appeal tail.
 * - C: assignment, and while reviewing (reserve activations add assignments).
 * - D: from the start of reviewing through the response window.
 * - E: the early-reject window only (the close report is computed at close).
 * - F: response, discussion, decisions (the MVP views).
 * - G: after decisions.
 */
export const MODULE_PHASES: Readonly<Record<ModuleId, readonly ExtendedPhaseName[]>> = {
  "reserve-compliance": ["registration", "submission", "quick-reject"],
  "quick-reject": ["quick-reject", "assignment"],
  "assignment-validator": ["assignment", "before-review-due", "reviewing-late", "early-reject"],
  "reviewing-by-tier": ["before-review-due", "reviewing-late", "early-reject", "response"],
  "early-reject": ["early-reject"],
  discussion: ["response", "discussion", "decisions"],
  "process-report": ["after-decisions"],
};

const MODULE_ORDER = Object.keys(MODULES) as ModuleId[];

/** The modules active in `phase`, in A-G order. */
export function activeModules(phase: ExtendedPhaseName): ModuleId[] {
  return MODULE_ORDER.filter((m) => MODULE_PHASES[m].includes(phase));
}
