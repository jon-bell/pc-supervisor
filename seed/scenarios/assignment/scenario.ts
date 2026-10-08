// The `assignment` scenario (PLAN M10): an assignment-phase state with
// deliberately planted problems for the assignment validator, plus fixture
// CSVs for `pcs import` (fixtures/). expected.ts lists every finding the
// validator must report, and nothing else.
//
// Planted in the HotCRP assignment (validated by `pcs validate-assignments`):
//   - #5 is an all-junior panel (j1, j2, j3): ALL_JUNIOR_PANEL + THIRD_SLOT_EXTRA;
//   - s1 (senior) reviews 4 papers, over PCS_LOAD_SENIOR_MAX=3 (ASSIGNMENT_ENV);
//   - s1 shares an affiliation with an author of #4;
//   - r1 (reserve-active) on #3 is only "pending" in the invites fixture;
//   - r3 (reserve-active) on #6 is approved but on the do-not-invite fixture;
//   - a reciprocal 2-cycle: s2 authors #1, which s3 reviews; s3 authors #2, which s2 reviews;
//   - a reciprocal 3-cycle: s4 authors #6 (reviewed by s5), s5 authors #7
//     (reviewed by s6), s6 authors #8 (reviewed by s4).
// Planted in fixtures/tpms-assignments.csv (`--tpms`): see expected.ts.
//
// Phase-2 foundations it also exercises: authors with affiliations (some of
// them PC members), the reserve-designee and exemption submission options, the
// four tiers as user tags (amara is a non-PC reserve-pool user), and the
// quickreject review round (#1's metareview is in it).
//
// Everything is invented; emails are @example.org.

import {
  QUICKREJECT_ROUND,
  RESERVE_DESIGNEE_FIELD,
  RESERVE_EXEMPTION_FIELD,
  TIER_TAGS,
  TIER_TAGS_ENV,
  at,
  type Assignment,
  type Author,
  type Person,
  type Scenario,
} from "../../src/format.js";

const e = (local: string) => `${local}@example.org`;

/** Short keys -> emails, for tests and expected.ts. */
export const A = {
  ac1: e("ac.hollis"),
  ac2: e("ac.marsh"),
  s1: e("sofia.lund"),
  s2: e("omar.reyes"),
  s3: e("lena.brandt"),
  s4: e("kwame.osei"),
  s5: e("ingrid.falk"),
  s6: e("tariq.nasser"),
  s7: e("maya.ito"),
  s8: e("piotr.sowa"),
  j1: e("jun.tanaka"),
  j2: e("ella.moreau"),
  j3: e("ravi.iyer"),
  r1: e("nora.quist"),
  r2: e("felix.adeyemi"),
  r3: e("greta.holm"),
  // Non-PC authors.
  a1: e("hana.kovac"),
  a2: e("luis.ortega"),
  a3: e("amara.diallo"),
  a4: e("ben.carver"),
  a5: e("chloe.martin"),
  a6: e("dario.bianchi"),
  a7: e("eva.lindqvist"),
  a8: e("farid.haddad"),
} as const;
type Key = keyof typeof A;

/** The shared affiliation behind the planted SAME_AFFILIATION finding. */
export const SHARED_AFFILIATION = "Lakeshore Institute of Technology";

const NAMES: Record<Key, [string, string, string]> = {
  ac1: ["Ada", "Hollis", "Carrow University"],
  ac2: ["Milo", "Marsh", "Westfen College"],
  s1: ["Sofia", "Lund", SHARED_AFFILIATION],
  s2: ["Omar", "Reyes", "University of Rivermouth"],
  s3: ["Lena", "Brandt", "Hallam Technical University"],
  s4: ["Kwame", "Osei", "Eastbrook University"],
  s5: ["Ingrid", "Falk", "Nordvik Institute"],
  s6: ["Tariq", "Nasser", "Sandstone University"],
  s7: ["Maya", "Ito", "Kestrel Labs"],
  s8: ["Piotr", "Sowa", "Vistula Polytechnic"],
  j1: ["Jun", "Tanaka", "Harbor City University"],
  j2: ["Ella", "Moreau", "Lyonnais Research Center"],
  j3: ["Ravi", "Iyer", "Deccan Institute of Science"],
  r1: ["Nora", "Quist", "Fjordline University"],
  r2: ["Felix", "Adeyemi", "Lagoon State University"],
  r3: ["Greta", "Holm", "Birchwood College"],
  a1: ["Hana", "Kovac", "Danube Software Group"],
  a2: ["Luis", "Ortega", "Altiplano University"],
  a3: ["Amara", "Diallo", "Sahel Institute of Computing"],
  a4: ["Ben", "Carver", SHARED_AFFILIATION],
  a5: ["Chloe", "Martin", "Loire Valley University"],
  a6: ["Dario", "Bianchi", "Apennine Polytechnic"],
  a7: ["Eva", "Lindqvist", "Baltic Tech"],
  a8: ["Farid", "Haddad", "Levant University"],
};

const PC: Partial<Record<Key, string[]>> = {
  ac1: [], ac2: [],
  s1: [], s2: [], s3: [], s4: [], s5: [], s6: [], s7: [], s8: [],
  j1: [TIER_TAGS.junior], j2: [TIER_TAGS.junior], j3: [TIER_TAGS.junior],
  r1: [TIER_TAGS["reserve-active"]], r2: [TIER_TAGS["reserve-active"]], r3: [TIER_TAGS["reserve-active"]],
};

const person = (k: Key): Person => {
  const [first, last, affiliation] = NAMES[k];
  const pcTags = PC[k];
  if (pcTags) return { email: A[k], first, last, affiliation, roles: ["pc"], tags: pcTags };
  // amara (a3) is a designated reserve who hasn't been activated: a non-PC user tagged reserve-pool.
  return { email: A[k], first, last, affiliation, roles: [], ...(k === "a3" ? { tags: [TIER_TAGS["reserve-pool"]] } : {}) };
};

const author = (k: Key): Author => {
  const [first, last, affiliation] = NAMES[k];
  return { email: A[k], first, last, affiliation };
};

const people: Person[] = (Object.keys(A) as Key[]).filter((k) => PC[k] || k === "a3").map(person);

/** pid -> author keys (first author is the designee unless the paper claims an exemption). */
const AUTHORS: Record<number, Key[]> = {
  1: ["s2", "a1"],
  2: ["s3", "a2"],
  3: ["a3"],
  4: ["a4"],
  5: ["a5"],
  6: ["s4", "a6"],
  7: ["s5", "a7"],
  8: ["s6", "a8"],
};

const TITLES: Record<number, string> = {
  1: "Incremental Type Inference for Gradual Pipelines",
  2: "Mining Flaky Test Histories at Scale",
  3: "Contracts for Configuration Drift",
  4: "Energy Profiles of Mobile Build Systems",
  5: "Explaining Merge Conflicts to Novices",
  6: "Fuzzing Protocol Parsers with Grammar Mutations",
  7: "Refactoring Recommendations from Code Review Logs",
  8: "Static Detection of Resource Leaks in Async Code",
};

const papers = Object.entries(AUTHORS).map(([pidStr, keys]) => {
  const pid = Number(pidStr);
  return {
    pid,
    title: TITLES[pid]!,
    authors: keys.map(author),
    // #5 claims an exemption instead of naming a designee.
    options:
      pid === 5
        ? { [RESERVE_EXEMPTION_FIELD.name]: "no-eligible-author" }
        : { [RESERVE_DESIGNEE_FIELD.name]: A[keys[0]!] },
  };
});

/** pid -> [seniors..., third slot...] (the HotCRP state). */
export const PANELS: Record<number, Key[]> = {
  1: ["s1", "s3", "j1"],
  2: ["s1", "s2", "j2"],
  3: ["s1", "s7", "r1"],
  4: ["s1", "s8", "r2"],
  5: ["j1", "j2", "j3"],
  6: ["s5", "s7", "r3"],
  7: ["s6", "s8", "j3"],
  8: ["s4", "s7", "j1"],
};

const assignments: Assignment[] = [
  ...Object.entries(PANELS).flatMap(([pid, keys]) =>
    keys.map((k, i): Assignment => ({ pid: Number(pid), email: A[k], role: i === 0 ? "primary" : i === 1 ? "secondary" : "pcreview" })),
  ),
  ...[1, 2, 3, 4].map((pid): Assignment => ({ pid, email: A.ac1, role: "metareview", ...(pid === 1 ? { round: QUICKREJECT_ROUND } : {}) })),
  ...[5, 6, 7, 8].map((pid): Assignment => ({ pid, email: A.ac2, role: "metareview" })),
];

export const scenario: Scenario = {
  name: "assignment",
  description: "Assignment phase with planted validator findings (all-junior panel, overload, reserve, do-not-invite, affiliation, 2- and 3-cycle)",
  people,
  papers,
  assignments,
  submissionFields: [RESERVE_DESIGNEE_FIELD, RESERVE_EXEMPTION_FIELD],
  reviewRounds: [QUICKREJECT_ROUND],
  // Assignment phase: before any review is written.
  stages: [{ name: "assigned", now: at("reviewDue", -21, "12:00"), events: [] }],
};

/** Fixture CSVs for `pcs import`, relative to this directory. */
export const FIXTURES = {
  invites: new URL("./fixtures/invites.csv", import.meta.url),
  "do-not-invite": new URL("./fixtures/do-not-invite.csv", import.meta.url),
  "tpms-assignments": new URL("./fixtures/tpms-assignments.csv", import.meta.url),
  // PLAN M10b: a synthetic affinity matrix for the solver (every PC reviewer x
  // every paper; the current panel scores 0.90, so the planted cycles are
  // what the solver would pick without its repair pass).
  "tpms-scores": new URL("./fixtures/tpms-scores.csv", import.meta.url),
} as const;

/**
 * Env the scenario is designed for (on top of the ci.yml phase dates): its
 * tiers, and load bands sized for 8 papers. The policy vars keep their defaults.
 */
export const ASSIGNMENT_ENV: Readonly<Record<string, string>> = {
  PCS_TIER_TAGS: TIER_TAGS_ENV,
  PCS_LOAD_SENIOR_MIN: "1",
  PCS_LOAD_SENIOR_MAX: "3",
  PCS_LOAD_JUNIOR_MIN: "1",
  PCS_LOAD_JUNIOR_MAX: "3",
  PCS_LOAD_RESERVE_ACTIVE_MIN: "1",
  PCS_LOAD_RESERVE_ACTIVE_MAX: "1",
  PCS_LOAD_RESERVE_POOL_MIN: "0",
  PCS_LOAD_RESERVE_POOL_MAX: "0",
};
