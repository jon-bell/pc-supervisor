// The `earlyreject` scenario's oracle (PLAN M12): what the tier-progress and
// early-reject modules must report at window open (after the stage-1 sync)
// and at window close (after the stage-2 sync), with earlyRejectEnv() on top
// of the ci.yml phase dates. scenario.ts explains each paper.
//
// Late days: OPEN is review due + 1 d 9 h 1 min (1.376 days), CLOSE is
// +3.376 days; PCS_RESERVE_DROPOUT_DAYS is the default 3.

import { E } from "./scenario.js";

/** "email@pid" keys, sorted. */
const pairs = (xs: [keyof typeof E, number][]) => xs.map(([k, pid]) => `${E[k]}@${pid}`).sort();

/** Early-reject candidates as of window open, per policy. */
export const CANDIDATES = {
  include_weak_reject: [1, 2, 3],
  reject_only: [2],
} as const;

export const MERITS_AT_OPEN: Record<number, number[]> = { 1: [1, 1, 2], 2: [1, 1, 1], 3: [2, 2, 2] };

/** At window close (include_weak_reject). */
export const AT_CLOSE = {
  bumped: [1],
  notBumped: [2, 3],
  /** No merit change and no comment during the window: "email@pid". */
  noResponse: pairs([
    ["s2", 1], // commented before the window only
    ["s4", 2],
    ["r1", 2], // submitted #7 in the window, but did nothing on #2
    ["s6", 3],
  ]),
  /** #1 left the band (3 > 2); #2 and #3 are still in it (#3 moved down). */
  stillInBand: { 1: false, 2: true, 3: true } as Record<number, boolean>,
};

export interface TierCounts {
  reviewers: number;
  assigned: number;
  submitted: number;
  outstanding: number;
  late: number;
  latePeople: number;
  submittedLate: number;
  assignedAfterDue: number;
}

const zero: TierCounts = { reviewers: 0, assigned: 0, submitted: 0, outstanding: 0, late: 0, latePeople: 0, submittedLate: 0, assignedAfterDue: 0 };

/** Outstanding and late reviews by tier (TIER_TAGS_ENV order). */
export const TIERS_AT_OPEN: Record<string, TierCounts> = {
  senior: { ...zero, reviewers: 6, assigned: 16, submitted: 16 },
  junior: { ...zero, reviewers: 2, assigned: 4, submitted: 3, outstanding: 1, late: 1, latePeople: 1 },
  "reserve-active": { ...zero, reviewers: 3, assigned: 5, submitted: 2, outstanding: 3, late: 3, latePeople: 3 },
  "reserve-pool": zero,
};
export const TIERS_AT_CLOSE: Record<string, TierCounts> = {
  // s5 added on #6 after the deadline: outstanding, not late.
  senior: { ...zero, reviewers: 6, assigned: 17, submitted: 16, outstanding: 1, assignedAfterDue: 1 },
  junior: { ...zero, reviewers: 2, assigned: 4, submitted: 3, outstanding: 1, late: 1, latePeople: 1 },
  // r1's #7 review landed in the window.
  "reserve-active": { ...zero, reviewers: 3, assigned: 5, submitted: 3, outstanding: 2, late: 2, latePeople: 2, submittedLate: 1 },
  "reserve-pool": zero,
};

/** Late reviews ("email@pid"). */
export const LATE_AT_OPEN = pairs([["j1", 8], ["r1", 7], ["r2", 6], ["r3", 5]]);
export const LATE_AT_CLOSE = pairs([["j1", 8], ["r2", 6], ["r3", 5]]);

/** Reserve dropout escalation states ("email@pid" -> state). */
export const DROPOUT_AT_OPEN: Record<string, string> = {
  [`${E.r3}@5`]: "pinged", // the AC @mentioned them a day after the deadline
  [`${E.r2}@6`]: "late",
  [`${E.r1}@7`]: "late",
};
export const DROPOUT_AT_CLOSE: Record<string, string> = {
  [`${E.r3}@5`]: "replacement-needed", // 3.4 days late > 3
  [`${E.r2}@6`]: "replaced", // s5 was added on #6 during the window
};
export const REPLACED_BY = { [`${E.r2}@6`]: [E.s5] };

export interface AccountabilityCounts {
  ownPapers: number[];
  assigned: number;
  submitted: number;
  lateOutstanding: number;
  submittedLate: number;
  thin: number;
  thinPids: number[];
}

/** One row per reserve-active reviewer, at close. */
export const ACCOUNTABILITY_AT_CLOSE: Record<string, AccountabilityCounts> = {
  [E.r1]: { ownPapers: [3], assigned: 2, submitted: 2, lateOutstanding: 0, submittedLate: 1, thin: 0, thinPids: [] },
  [E.r2]: { ownPapers: [1], assigned: 2, submitted: 1, lateOutstanding: 1, submittedLate: 0, thin: 1, thinPids: [4] },
  [E.r3]: { ownPapers: [2, 8], assigned: 1, submitted: 0, lateOutstanding: 1, submittedLate: 0, thin: 0, thinPids: [] },
};

/** Coaching queue (junior reviews under 150 words): "email@pid" -> words. */
export const COACHING: Record<string, number> = { [`${E.j1}@1`]: 120, [`${E.j2}@8`]: 60 };

/** PCS_POLICY_WITHHOLD_REVIEWS=true: the papers whose reviews would be withheld. */
export const WITHHELD_AT_OPEN = [1, 2, 3, 8];
export const WITHHELD_AT_CLOSE = [1, 2, 8];

/** Participation by tier at close: reviewers who commented on papers they review, and their comments. */
export const PARTICIPATION_AT_CLOSE: Record<string, { commenters: number; comments: number }> = {
  senior: { commenters: 2, comments: 3 }, // s2 on #1 (before the window), s3 on #2 and #4
  junior: { commenters: 2, comments: 2 },
  "reserve-active": { commenters: 0, comments: 0 },
  "reserve-pool": { commenters: 0, comments: 0 },
};
