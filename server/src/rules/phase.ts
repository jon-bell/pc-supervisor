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
}

export function phaseTimesFromConfig(p: Phases): PhaseTimes {
  return {
    reviewDue: p.reviewDue.getTime(),
    responseOpen: p.responseOpen ? p.responseOpen.getTime() : null,
    responseClose: p.responseClose ? p.responseClose.getTime() : null,
    discussionOpen: p.discussionOpen.getTime(),
    discussionClose: p.discussionClose.getTime(),
    decisionsDue: p.decisionsDue.getTime(),
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
