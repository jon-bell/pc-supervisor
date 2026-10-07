// What the assignment validator must report for the `assignment` scenario,
// under ASSIGNMENT_ENV, after `pcs import` of the three fixtures. Each entry
// is `CODE pid emails...` (emails in the finding's order); the integration
// test compares the full list, so anything extra fails.

import { A } from "./scenario.js";

const f = (code: string, pid: number | undefined, ...emails: string[]) => `${code} ${pid ?? "-"} ${emails.join(" ")}`;

/** `pcs validate-assignments` (the HotCRP assignment). */
export const EXPECTED_HOTCRP: readonly string[] = [
  f("ALL_JUNIOR_PANEL", 5, ...[A.j1, A.j2, A.j3].sort()),
  f("THIRD_SLOT_EXTRA", 5, ...[A.j1, A.j2, A.j3].sort()),
  f("LOAD_OVER", undefined, A.s1),
  f("SAME_AFFILIATION", 4, A.s1, A.a4),
  f("RESERVE_NOT_APPROVED", 3, A.r1),
  f("DO_NOT_INVITE", 6, A.r3),
  // Cycles start at the smallest email: lena.brandt (s3); ingrid.falk (s5).
  f("RECIPROCAL_CYCLE", 1, A.s3, A.s2),
  f("RECIPROCAL_CYCLE", 6, A.s5, A.s6, A.s4),
];

/** `pcs validate-assignments --tpms` (fixtures/tpms-assignments.csv). */
export const EXPECTED_TPMS: readonly string[] = [
  f("UNKNOWN_PAPER", 99, A.s8),
  f("NOT_PC_MEMBER", 2, "outsider.olsen@example.org"),
  f("THIRD_SLOT_EXTRA", 2, ...[A.s1, A.s2, A.j2, A.j3].sort()),
  f("AUTHOR_IS_REVIEWER", 1, A.s2),
  f("SAME_AFFILIATION", 4, A.s1, A.a4),
  f("RESERVE_NOT_APPROVED", 3, A.r1),
  f("DO_NOT_INVITE", 6, A.r3),
  f("RECIPROCAL_CYCLE", 1, A.s3, A.s2),
  f("RECIPROCAL_CYCLE", 6, A.s5, A.s6, A.s4),
];

/** The TPMS fix-up CSV: seniors (by score) then the third slot, after clearreview lines. */
export const EXPECTED_TPMS_FIXUP: readonly string[] = [
  "paper,action,user",
  `1,clearreview,${A.s1}`,
  `1,secondary,${A.s3}`, // s3 is already secondary on #1: its role is kept
  `1,primary,${A.s7}`,
  `1,pcreview,${A.j1}`,
  `2,primary,${A.s1}`,
  `2,secondary,${A.s2}`,
  `2,pcreview,${A.j2}`,
  `3,clearreview,${A.r1}`,
  `3,primary,${A.s1}`,
  `3,secondary,${A.s7}`,
  `4,clearreview,${A.s1}`,
  `4,secondary,${A.s8}`,
  `4,pcreview,${A.r2}`,
  `5,clearreview,${A.j2}`,
  `5,clearreview,${A.j3}`,
  `5,primary,${A.s5}`,
  `5,primary,${A.s6}`,
  `5,primary,${A.j1}`,
  `6,clearreview,${A.r3}`,
  `6,primary,${A.s5}`,
  `6,secondary,${A.s7}`,
  `7,primary,${A.s6}`,
  `7,secondary,${A.s8}`,
  `7,pcreview,${A.j3}`,
  `8,clearreview,${A.s7}`,
  `8,primary,${A.s4}`,
  `8,primary,${A.s8}`,
  `8,pcreview,${A.j1}`,
];
