// The golden oracle (PLAN.md "Golden scenario"): which rules each paper fires,
// and the people-level facts, at the two assertion instants. M4's unit tests
// and M5/M6's Playwright specs assert against this; M3's integration test
// asserts the synced DB against the scenario itself (./scenario.ts).
//
// Instants are phase-relative; with the ci.yml dates (PCS_TZ America/New_York):
//   primary = 2030-02-26T12:00, second = 2030-03-01T12:00.

import type { RuleName } from "@pcs/server/config";
import { P } from "./scenario.js";

export { NOW_PRIMARY, NOW_SECOND } from "./scenario.js";

/** Rules fired by each pid at NOW_PRIMARY: exactly these, no others. */
export const FIRES_AT_PRIMARY: Readonly<Record<number, readonly RuleName[]>> = {
  1: [],
  2: ["MISSING_REVIEWS"],
  3: ["SPLIT"],
  4: ["SPLIT", "UNRESOLVED_SPLIT"],
  5: ["SILENT_DISCUSSION", "AC_ABSENT", "GONE_QUIET"],
  6: ["GONE_QUIET"],
  7: ["AC_ABSENT"],
  8: ["CHAMPION_MISSING"],
  9: ["LOW_EXPERTISE"],
  10: ["THIN_REVIEWS"],
  11: ["RESPONSE_UNADDRESSED"],
  12: ["SPLIT"],
  13: ["REVIEW_FLAGGED"],
};

/** At NOW_SECOND only these are asserted; other rows drift with time. */
export const AT_SECOND = {
  /** pid -> rules that must be among those fired. */
  includes: { 12: ["DEADLINE_NO_CONSENSUS"] } as Readonly<Record<number, readonly RuleName[]>>,
  /** pid -> exactly these rules. */
  exactly: { 1: [] } as Readonly<Record<number, readonly RuleName[]>>,
};

/** Current merit (OveMer) per pid at NOW_PRIMARY, complete non-AC reviews only, sorted. Metareviews carry no scores. */
export const MERITS: Readonly<Record<number, readonly number[]>> = {
  1: [3, 3, 4],
  2: [3, 4],
  3: [2, 4, 4],
  4: [2, 4, 4],
  5: [2, 2, 2],
  6: [4, 4, 4],
  7: [3, 3, 4],
  8: [4, 4, 5],
  9: [3, 3, 4],
  10: [3, 3, 4],
  11: [2, 2, 2],
  12: [2, 4, 4],
  13: [3, 3, 4],
};

/** Review ratings (raters per flag) by pid and reviewer; every other review is unrated. */
export const RATINGS = [
  { pid: 10, email: P.hal, ordinal: "B", ratings: { short: 2 } },
  { pid: 13, email: P.hal, ordinal: "B", ratings: { short: 1, disrespectful: 1 } },
] as const;

/** Score movement after discussion opened (review_version history). */
export const SCORE_CHANGES = [
  { pid: 3, email: P.silent, field: "OveMer", from: 1, to: 2, day: 6 },
  { pid: 12, email: P.silent, field: "OveMer", from: 1, to: 2, day: 5 },
] as const;

export const PEOPLE = {
  acs: {
    [P.acBusy]: { label: "AC-busy", pids: [1, 3, 4, 8, 9, 10], flagged: [3, 4, 8, 9, 10], commentsOnAll: true },
    [P.acIdle]: { label: "AC-idle", pids: [5, 7], flagged: [5, 7], comments: 0 },
    [P.acNormal]: { label: "AC-normal", pids: [2, 6, 11, 12, 13], flagged: [2, 6, 11, 12, 13] },
  },
  tiers: {
    junior: [P.silent],
    reciprocal: [P.recip],
    /** Everyone else on the PC is senior (untagged). */
  },
  /** R-silent: low scorer on 3, 4, 12; never comments anywhere. */
  silentOnSplit: { [P.silent]: [3, 4, 12], [P.pinged]: [4] },
  /** R-pinged: @mentioned by AC-busy on pid 4, day +3 09:00; never comments there (11+ days unanswered). */
  unansweredPings: [{ email: P.pinged, pid: 4, by: P.acBusy, day: 3 }],
  /** The pid 2 laggard: assigned (primary, slot 0), review still empty, tagged reciprocal. */
  laggard: { email: P.recip, pid: 2 },
  /** The 5 on pid 8 who never comments. */
  championMissing: { email: P.champ, pid: 8 },
  /** Response on pid 11, by its contact author, 2030-02-09T12:00. */
  response: { email: P.author11, pid: 11 },
  /** Hal: negative rating flags on two papers (10: 2× short; 13: 1× short, 1× disrespectful). */
  repeatedlyFlagged: { email: P.hal, pids: [10, 13] },
  /** pid 1: decision "Accepted" and the AC's metareview (complete, no scores) on day +10. */
  decided: { pid: 1, decision: "Accepted", day: 10 },
  /**
   * Discussion leads (scenario LEADS): their papers, and those where the lead
   * has a published comment (any time). Seven papers have no lead.
   */
  leads: {
    [P.ben]: { pids: [1, 3, 11], commented: [1, 3] },
    [P.champ]: { pids: [8], commented: [] },
    [P.eli]: { pids: [6, 12], commented: [6, 12] },
  },
} as const;
