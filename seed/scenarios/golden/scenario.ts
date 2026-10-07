// The golden scenario: PLAN.md "Golden scenario" table, the contract between
// M2 (seeder), M3 (sync), and M4 (rules). 12 papers, each built to fire an
// exact set of rules at PCS_NOW = discussionOpen +14d 12:00 (2030-02-26T12:00
// with the ci.yml dates). The rule oracle is ./expected.ts.
//
// People, emails, scores, and the schedule match M4's in-memory fixture
// (server/test/fixtures/golden.ts) so the rules can run over seeded data:
// - reviews submitted reviewDue -12d + ((pid + slot) % 10) days, at 10:00
//   (2030-01-20 .. 01-29);
// - reviewer comments on discussion days +3/+8/+13 by slot, at 12:00;
// - AC comments at 09:00; the decided paper's metareview at day +10 09:00.
// Slot 0 is a primary review (rtype 4), slots 1-2 secondary (rtype 3).
// All people are invented.

import { at, type Assignment, type Paper, type Person, type Scenario, type ScenarioEvent, type When } from "../../src/format.js";

// --- People -------------------------------------------------------------------

export const P = {
  acBusy: "ac-busy@example.org",
  acIdle: "ac-idle@example.org",
  acNormal: "ac-normal@example.org",
  silent: "r-silent@example.org",
  pinged: "r-pinged@example.org",
  recip: "r-recip@example.org",
  champ: "r-champ@example.org",
  ana: "r-ana@example.org",
  ben: "r-ben@example.org",
  cal: "r-cal@example.org",
  dee: "r-dee@example.org",
  eli: "r-eli@example.org",
  fay: "r-fay@example.org",
  gus: "r-gus@example.org",
  hal: "r-hal@example.org",
  author11: "author11@example.org",
} as const;

const NAMES: readonly (readonly [email: string, first: string, last: string, tag?: string])[] = [
  [P.acBusy, "Avery", "Busyfield"],
  [P.acIdle, "Indra", "Idleworth"],
  [P.acNormal, "Noor", "Normandy"],
  [P.silent, "Sam", "Silvermoon", "junior"],
  [P.pinged, "Pat", "Pingleton"],
  [P.recip, "Remy", "Reciprocca", "reciprocal"],
  [P.champ, "Charlie", "Champlain"],
  [P.ana, "Ana", "Arbortown"],
  [P.ben, "Ben", "Brookvale"],
  [P.cal, "Cal", "Cedarholm"],
  [P.dee, "Dee", "Dunmore"],
  [P.eli, "Eli", "Elmsworth"],
  [P.fay, "Fay", "Fernhill"],
  [P.gus, "Gus", "Glenrock"],
  [P.hal, "Hal", "Hollowmere"],
];

export const people: Person[] = NAMES.map(([email, first, last, tag]) => ({
  email,
  first,
  last,
  affiliation: "Example Institute",
  roles: ["pc"],
  tags: tag ? [tag] : [],
}));

// --- Papers ---------------------------------------------------------------------

const TITLES = [
  "Incremental Slicing for Evolving Build Graphs",
  "Probabilistic Flake Triage in Continuous Integration",
  "Typed Holes for Gradual Refactoring",
  "Mining Commit Rationale at Scale",
  "Lightweight Contracts for Configuration Files",
  "Test Amplification via Mutation Feedback",
  "Energy Profiles of Mobile Test Suites",
  "Synthesizing Migration Scripts from Examples",
  "Reviewer Fatigue in Code Review Bots",
  "Fuzzing Stateful Network Daemons with Grammars",
  "Traceability Links from Issue Discussions",
  "Static Detection of Resource Leaks in Async Code",
];
const AUTHOR_LAST = ["Arden", "Bellamy", "Corvell", "Dunsmore", "Elsworth", "Fairbank", "Galloway", "Hartwell", "Ingram", "Jessop", "Kirkland", "Lowther"];

export const papers: Paper[] = TITLES.map((title, i) => ({
  pid: i + 1,
  title,
  authors: [{ email: `author${i + 1}@example.org`, first: "Ari", last: AUTHOR_LAST[i]!, affiliation: "Example University" }],
}));

// --- Per-paper spec (M4 fixture) ------------------------------------------------------

interface Slot {
  email: string;
  /** Default 3. */
  merit?: number;
  /** Default by slot: 3, 4, 3. */
  expertise?: number;
  /** Default 250. */
  words?: number;
  empty?: boolean;
  move?: { day: number; to: number };
  /** Comment days; default by slot (+3, +8, +13). [] = never. */
  comments?: number[];
}

interface PaperSpec {
  pid: number;
  ac: string;
  slots: readonly [Slot, Slot, Slot];
  acComments: readonly { day: number; mentions?: string[] }[];
  decisionDay?: number;
  response?: boolean;
}

const DEFAULT_COMMENT_DAYS = [3, 8, 13];
const DEFAULT_EXPERTISE = [3, 4, 3];

export const SPECS: readonly PaperSpec[] = [
  { pid: 1, ac: P.acBusy, slots: [{ email: P.ana }, { email: P.ben }, { email: P.cal, merit: 4, comments: [9] }], acComments: [{ day: 1 }], decisionDay: 10 },
  { pid: 2, ac: P.acNormal, slots: [{ email: P.recip, empty: true, comments: [] }, { email: P.ana }, { email: P.dee, merit: 4 }], acComments: [{ day: 1 }] },
  {
    pid: 3,
    ac: P.acBusy,
    slots: [{ email: P.silent, merit: 1, move: { day: 6, to: 2 }, comments: [] }, { email: P.ben, merit: 4 }, { email: P.eli, merit: 4 }],
    acComments: [{ day: 1 }],
  },
  {
    pid: 4,
    ac: P.acBusy,
    slots: [{ email: P.silent, merit: 2, comments: [] }, { email: P.pinged, merit: 4, comments: [] }, { email: P.cal, merit: 4 }],
    acComments: [{ day: 1 }, { day: 3, mentions: [P.pinged] }],
  },
  {
    pid: 5,
    ac: P.acIdle,
    slots: [{ email: P.dee, merit: 2, comments: [] }, { email: P.fay, merit: 2, comments: [] }, { email: P.gus, merit: 2, comments: [] }],
    acComments: [],
  },
  {
    pid: 6,
    ac: P.acNormal,
    slots: [{ email: P.eli, merit: 4, comments: [2] }, { email: P.fay, merit: 4, comments: [2] }, { email: P.hal, merit: 4, comments: [2] }],
    acComments: [{ day: 1 }],
  },
  { pid: 7, ac: P.acIdle, slots: [{ email: P.ana }, { email: P.gus }, { email: P.hal, merit: 4 }], acComments: [] },
  // PLAN row changed 5/3/3 -> 5/4/4 (5/3/3 has range 2 = SPLIT).
  { pid: 8, ac: P.acBusy, slots: [{ email: P.champ, merit: 5, comments: [] }, { email: P.ben, merit: 4 }, { email: P.dee, merit: 4 }], acComments: [{ day: 1 }] },
  {
    pid: 9,
    ac: P.acBusy,
    slots: [{ email: P.cal, expertise: 2 }, { email: P.eli, expertise: 2 }, { email: P.fay, merit: 4, expertise: 1 }],
    acComments: [{ day: 1 }],
  },
  { pid: 10, ac: P.acBusy, slots: [{ email: P.gus }, { email: P.hal, words: 35 }, { email: P.ana, merit: 4 }], acComments: [{ day: 1 }] },
  // PLAN row changed to 2/2/2 (with silent reviewers, a top merit >= 3 is CHAMPION_MISSING).
  {
    pid: 11,
    ac: P.acNormal,
    slots: [{ email: P.ben, merit: 2, comments: [] }, { email: P.cal, merit: 2, comments: [] }, { email: P.dee, merit: 2, comments: [] }],
    acComments: [{ day: 1 }, { day: 12 }],
    response: true,
  },
  {
    pid: 12,
    ac: P.acNormal,
    slots: [{ email: P.silent, merit: 1, move: { day: 5, to: 2 }, comments: [] }, { email: P.eli, merit: 4 }, { email: P.hal, merit: 4 }],
    acComments: [{ day: 1 }],
  },
];

// --- Build ---------------------------------------------------------------------------

/** Discussion day +d at HH:00 local. */
const day = (d: number, hour = 12): When => at("discussionOpen", d, `${String(hour).padStart(2, "0")}:00`);

export const assignments: Assignment[] = SPECS.flatMap((s) => [
  { pid: s.pid, email: s.ac, role: "metareview" as const },
  ...s.slots.map((slot, i) => ({ pid: s.pid, email: slot.email, role: i === 0 ? ("primary" as const) : ("secondary" as const) })),
]);

const events: ScenarioEvent[] = [];
for (const s of SPECS) {
  s.slots.forEach((slot, i) => {
    if (!slot.empty) {
      events.push({
        type: "review",
        // 2030-01-20 .. 01-29 at 10:00 with the ci.yml review deadline (02-01).
        at: at("reviewDue", -12 + ((s.pid + i) % 10), "10:00"),
        pid: s.pid,
        email: slot.email,
        scores: { OveMer: slot.merit ?? 3, RevExp: slot.expertise ?? DEFAULT_EXPERTISE[i]! },
        words: slot.words ?? 250,
      });
    }
    if (slot.move) {
      events.push({ type: "scoreChange", at: day(slot.move.day), pid: s.pid, email: slot.email, scores: { OveMer: slot.move.to } });
    }
    (slot.comments ?? [DEFAULT_COMMENT_DAYS[i]!]).forEach((d, k) => {
      events.push({ type: "comment", key: `g${s.pid}-r${i}-${k}`, at: day(d), pid: s.pid, email: slot.email });
    });
  });
  s.acComments.forEach((c, k) => {
    events.push({
      type: "comment",
      key: `g${s.pid}-ac-${k}`,
      at: day(c.day, 9),
      pid: s.pid,
      email: s.ac,
      ...(c.mentions ? { mentions: c.mentions } : {}),
    });
  });
  if (s.decisionDay !== undefined) {
    // The AC's metareview (text only, no scores) at 09:00, the decision at 12:00.
    events.push({ type: "review", at: day(s.decisionDay, 9), pid: s.pid, email: s.ac, scores: {}, words: 120 });
    events.push({ type: "decision", at: day(s.decisionDay), pid: s.pid, decision: "Accepted" });
  }
  if (s.response) {
    // 2030-02-09T12:00.
    events.push({ type: "response", key: `g${s.pid}-response`, at: at("responseOpen", 1, "12:00"), pid: s.pid, email: P.author11, words: 400 });
  }
}

/** The primary assertion instant (PCS_NOW for M3/M4/M5 tests). */
export const NOW_PRIMARY: When = at("discussionOpen", 14, "12:00");
/** The second instant: ~2.5 days before decisions are due (2030-03-01T12:00). */
export const NOW_SECOND: When = at("decisionsDue", -2, "12:00");

export const scenario: Scenario = {
  name: "golden",
  description: "PLAN.md golden table: 12 papers, each firing an exact rule set at discussion day +14",
  people,
  papers,
  assignments,
  stages: [{ name: "all", now: NOW_PRIMARY, events }],
};

export default scenario;
