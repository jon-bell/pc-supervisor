// The `earlyreject` scenario (PLAN M12): two stages around the early-reject
// window, for reviewing-by-tier (spec §10.4 D) and early reject (§10.4 E).
//
//   stage 1 (observe at OPEN_AT = review due +2 d 09:00): reviews before the
//           deadline, early-reject candidates, tiered reviewers with late
//           reserve-active and junior reviews, thin junior reviews, an AC
//           @mention of a late reserve reviewer;
//   sync at window open;
//   stage 2 (observe at CLOSE_AT = review due +4 d 09:00): during the window
//           some reviewers raise or lower merits, some comment, others do
//           nothing; a late reserve review lands; a replacement reviewer is
//           added for another;
//   sync at window close.
//
// The window is not a phase the seeder knows: OPEN_AT and CLOSE_AT are
// offsets from PCS_PHASE_REVIEW_DUE, and earlyRejectEnv() turns them into the
// PCS_PHASE_EARLYREJECT_OPEN/CLOSE values (2030-02-03T09:00 / 2030-02-05T09:00
// with the ci.yml dates: after REVIEW_DUE, before RESPONSE_OPEN).
// expected.ts holds every expected output. Invented names, @example.org.

import { formatInZone } from "@pcs/server/tz";
import { TIER_TAGS, TIER_TAGS_ENV, at, type Assignment, type Author, type Person, type Scenario, type ScenarioEvent, type When } from "../../src/format.js";
import { resolveWhen, type PhaseContext } from "../../src/time.js";

const e = (local: string) => `${local}@example.org`;

/** Short keys -> emails, for tests and expected.ts. */
export const E = {
  ac1: e("wren.halloway"),
  ac2: e("tobias.ferrante"),
  s1: e("ines.okafor"),
  s2: e("paolo.brandvold"),
  s3: e("mei.castellanos"),
  s4: e("jonas.iverholt"),
  s5: e("dara.quillfeather"),
  s6: e("lucas.ambroise"),
  j1: e("kit.ramsden"),
  j2: e("noor.elzein"),
  r1: e("hedda.vang"),
  r2: e("bruno.salcedo"),
  r3: e("yuki.tamsin"),
  a1: e("omar.lindqvist"),
  a2: e("sana.rhee"),
  a3: e("viktor.anand"),
  a4: e("lena.osterberg"),
  a5: e("teo.marchetti"),
  a6: e("ruth.abara"),
  a7: e("finn.kowal"),
  a8: e("ayla.serrano"),
} as const;

/** The window: review due +2 days 09:00 .. +4 days 09:00 (48 h). */
export const OPEN_AT: When = at("reviewDue", 2, "09:00");
export const CLOSE_AT: When = at("reviewDue", 4, "09:00");

const local = (w: When, ctx: PhaseContext) => formatInZone(resolveWhen(w, ctx), ctx.tz).slice(0, 16);

/**
 * Env for the modules (on top of the ci.yml phase dates): tiers, the window,
 * the weak-reject band, and the withhold policy turned on.
 */
export function earlyRejectEnv(ctx: PhaseContext): Record<string, string> {
  return {
    PCS_TIER_TAGS: TIER_TAGS_ENV,
    PCS_PHASE_EARLYREJECT_OPEN: local(OPEN_AT, ctx),
    PCS_PHASE_EARLYREJECT_CLOSE: local(CLOSE_AT, ctx),
    PCS_POLICY_EARLYREJECT: "include_weak_reject",
    PCS_POLICY_WITHHOLD_REVIEWS: "true",
  };
}

const AFF = "Example Polytechnic";
const pc = (email: string, first: string, last: string, tags: string[] = []): Person => ({
  email,
  first,
  last,
  affiliation: AFF,
  roles: ["pc"],
  tags,
});
const author = (email: string, first: string, last: string): Author => ({ email, first, last, affiliation: "Example University" });

const people: Person[] = [
  pc(E.ac1, "Wren", "Halloway"),
  pc(E.ac2, "Tobias", "Ferrante"),
  pc(E.s1, "Ines", "Okafor"),
  pc(E.s2, "Paolo", "Brandvold"),
  pc(E.s3, "Mei", "Castellanos"),
  pc(E.s4, "Jonas", "Iverholt"),
  pc(E.s5, "Dara", "Quillfeather"),
  pc(E.s6, "Lucas", "Ambroise"),
  pc(E.j1, "Kit", "Ramsden", [TIER_TAGS.junior]),
  pc(E.j2, "Noor", "Elzein", [TIER_TAGS.junior]),
  pc(E.r1, "Hedda", "Vang", [TIER_TAGS["reserve-active"]]),
  pc(E.r2, "Bruno", "Salcedo", [TIER_TAGS["reserve-active"]]),
  pc(E.r3, "Yuki", "Tamsin", [TIER_TAGS["reserve-active"]]),
];

const pcAuthor = (k: "r1" | "r2" | "r3"): Author => {
  const p = people.find((x) => x.email === E[k])!;
  return { email: p.email, first: p.first, last: p.last, affiliation: AFF };
};

// Reserve reviewers are authors too: r2 of #1, r3 of #2 and #8, r1 of #3.
const papers = [
  { pid: 1, title: "Incremental Slicing for Flaky Test Triage", authors: [pcAuthor("r2"), author(E.a1, "Omar", "Lindqvist")] },
  { pid: 2, title: "A Survey of Build Cache Poisoning", authors: [pcAuthor("r3"), author(E.a2, "Sana", "Rhee")] },
  { pid: 3, title: "Typed Holes for Spreadsheet Formulas", authors: [pcAuthor("r1"), author(E.a3, "Viktor", "Anand")] },
  { pid: 4, title: "Mining Commit Messages for Intent", authors: [author(E.a4, "Lena", "Osterberg")] },
  { pid: 5, title: "Energy Profiles of Continuous Integration", authors: [author(E.a5, "Teo", "Marchetti")] },
  { pid: 6, title: "Refactoring Detection Across Languages", authors: [author(E.a6, "Ruth", "Abara")] },
  { pid: 7, title: "Property-Based Tests from API Docs", authors: [author(E.a7, "Finn", "Kowal")] },
  { pid: 8, title: "Static Detection of Retry Storms", authors: [pcAuthor("r3"), author(E.a8, "Ayla", "Serrano")] },
];

type K = keyof typeof E;
const panel: [number, K, K[]][] = [
  // pid, AC, reviewers (slot 0 primary, slot 1 secondary, then pcreview)
  [1, "ac1", ["s1", "s2", "j1"]],
  [2, "ac1", ["s3", "s4", "r1"]],
  [3, "ac1", ["s5", "s6", "j2"]],
  [4, "ac1", ["s1", "s3", "r2"]],
  [5, "ac2", ["s2", "s4", "r3"]],
  [6, "ac2", ["s6", "s2", "r2"]],
  [7, "ac2", ["s4", "s1", "r1"]],
  [8, "ac2", ["s3", "s5", "j2", "j1"]], // j1 is a 4th review, never submitted
];
const assignments: Assignment[] = panel.flatMap(([pid, ac, rs]) => [
  { pid, email: E[ac], role: "metareview" as const },
  ...rs.map((r, i) => ({ pid, email: E[r], role: i === 0 ? ("primary" as const) : i === 1 ? ("secondary" as const) : ("pcreview" as const) })),
]);

const sub = (day: number) => at("reviewDue", day, "10:00");
const rd = (day: number, time: string) => at("reviewDue", day, time);
const review = (pid: number, k: K, merit: number, expertise: number, when: When, words = 250): ScenarioEvent => ({
  type: "review",
  at: when,
  pid,
  email: E[k],
  scores: { OveMer: merit, RevExp: expertise },
  words,
});

const stage1: ScenarioEvent[] = [
  // #1: 1/1/2, a candidate under include_weak_reject. j1's review is thin (120 words).
  review(1, "s1", 1, 3, sub(-6)),
  review(1, "s2", 1, 4, sub(-5)),
  review(1, "j1", 2, 2, sub(-3), 120),
  // #2: 1/1/1, a candidate under both policies.
  review(2, "s3", 1, 4, sub(-6)),
  review(2, "s4", 1, 3, sub(-4)),
  review(2, "r1", 1, 2, sub(-2)),
  // #3: 2/2/2, a candidate under include_weak_reject only.
  review(3, "s5", 2, 3, sub(-5)),
  review(3, "s6", 2, 4, sub(-4)),
  review(3, "j2", 2, 3, sub(-3)),
  // #4: 1/4/2, not a candidate. r2's review is thin (80 words; reserve, so not coached).
  review(4, "s1", 1, 3, sub(-5)),
  review(4, "s3", 4, 4, sub(-4)),
  review(4, "r2", 2, 2, sub(-1), 80),
  // #5: 2/2 with r3 (reserve) late: too few reviews to be a candidate.
  review(5, "s2", 2, 3, sub(-6)),
  review(5, "s4", 2, 4, sub(-5)),
  // #6: 3/4 with r2 (reserve) late; a replacement is added in stage 2.
  review(6, "s6", 3, 3, sub(-6)),
  review(6, "s2", 4, 4, sub(-4)),
  // #7: 3/3 with r1 (reserve) late; r1 submits during the window.
  review(7, "s4", 3, 3, sub(-5)),
  review(7, "s1", 3, 4, sub(-3)),
  // #8: 4/3/3; j2's review is thin (60 words); j1 (4th) never submits.
  review(8, "s3", 4, 3, sub(-6)),
  review(8, "s5", 3, 4, sub(-5)),
  review(8, "j2", 3, 2, sub(-2), 60),
  // After the deadline, before the window.
  { type: "comment", key: "er-c1", pid: 5, email: E.ac2, at: rd(1, "10:00"), mentions: [E.r3] }, // pings r3
  { type: "comment", key: "er-c2", pid: 1, email: E.s2, at: rd(1, "11:00") }, // before the window: not a response
  { type: "comment", key: "er-c3", pid: 2, email: E.ac1, at: rd(1, "12:00") },
];

const stage2: ScenarioEvent[] = [
  { type: "scoreChange", pid: 1, email: E.s1, scores: { OveMer: 3 }, at: rd(2, "15:00") }, // bump: #1 is bumped
  { type: "comment", key: "er-c5", pid: 2, email: E.s3, at: rd(2, "18:00") }, // responds, no bump
  { type: "assign", pid: 6, email: E.s5, role: "pcreview", at: rd(3, "09:00") }, // replaces r2 on #6
  { type: "comment", key: "er-c4", pid: 1, email: E.j1, at: rd(3, "10:00") },
  { type: "scoreChange", pid: 3, email: E.s5, scores: { OveMer: 1 }, at: rd(3, "11:00") }, // lowered: a response, not a bump
  { type: "comment", key: "er-c6", pid: 3, email: E.j2, at: rd(3, "12:00") },
  review(7, "r1", 3, 3, rd(3, "14:00")), // r1's late review lands
  { type: "comment", key: "er-c7", pid: 4, email: E.s3, at: rd(3, "16:00") }, // not a candidate
];

export const scenario: Scenario = {
  name: "earlyreject",
  description: "Two stages around the early-reject window: candidates, bumps, comments, late reserve reviews, a replacement",
  people,
  papers,
  assignments,
  stages: [
    { name: "before the window", now: OPEN_AT, events: stage1 },
    { name: "during the window", now: CLOSE_AT, events: stage2 },
  ],
};
