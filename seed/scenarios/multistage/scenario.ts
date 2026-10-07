// A two-stage scenario for M3's snapshot-diff integration test. Seed stage 1,
// sync at PCS_NOW = STAGE1_NOW, seed stage 2, sync at PCS_NOW = STAGE2_NOW,
// then assert the diffs. seed/README.md lists exactly what each stage holds.

import { at, type Person, type Scenario, type ScenarioEvent, type When } from "../../src/format.js";

export const M = {
  ac: "ms-ac@example.org",
  ana: "ms-ana@example.org",
  bo: "ms-bo@example.org",
  cy: "ms-cy@example.org",
  dee: "ms-dee@example.org",
} as const;

const pc = (email: string, first: string, last: string, tags: string[] = []): Person => ({
  email,
  first,
  last,
  affiliation: "Example Institute",
  roles: ["pc"],
  tags,
});

/** Stage 1 is observed at discussion day +3 12:00 (2030-02-15T12:00 with ci.yml dates). */
export const STAGE1_NOW: When = at("discussionOpen", 3, "12:00");
/** Stage 2 at discussion day +7 12:00 (2030-02-19T12:00). */
export const STAGE2_NOW: When = at("discussionOpen", 7, "12:00");

const d = (day: number, time: string) => at("discussionOpen", day, time);
const sub = (day: number) => at("reviewDue", day, "10:00");

const review = (pid: number, email: string, merit: number, expertise: number, when: When): ScenarioEvent => ({
  type: "review",
  at: when,
  pid,
  email,
  scores: { OveMer: merit, RevExp: expertise },
  words: 240,
});

const stage1: ScenarioEvent[] = [
  review(1, M.ana, 2, 3, sub(-5)),
  review(1, M.bo, 4, 3, sub(-4)),
  review(1, M.cy, 4, 4, sub(-3)),
  review(2, M.ana, 3, 3, sub(-5)),
  review(2, M.bo, 3, 4, sub(-4)),
  review(2, M.cy, 4, 3, sub(-2)),
  // pid 2: ms-dee is assigned (a 4th review) but never submits; unassigned in stage 2.
  review(3, M.bo, 4, 3, sub(-6)),
  review(3, M.cy, 3, 3, sub(-3)),
  review(3, M.dee, 3, 4, sub(-1)),
  { type: "comment", key: "ms-c1", pid: 1, email: M.ac, at: d(1, "09:00"), mentions: [M.ana] },
  { type: "comment", key: "ms-c2", pid: 1, email: M.ana, at: d(2, "10:00") },
  { type: "comment", key: "ms-c3", pid: 2, email: M.ac, at: d(1, "11:00") },
  { type: "comment", key: "ms-c4", pid: 2, email: M.bo, at: d(2, "15:00") },
  { type: "comment", key: "ms-c5", pid: 3, email: M.cy, at: d(2, "16:00") },
];

const stage2: ScenarioEvent[] = [
  // Score change: ms-ana on pid 1 moves merit 2 -> 3 on day +4.
  { type: "scoreChange", pid: 1, email: M.ana, scores: { OveMer: 3 }, at: d(4, "10:00") },
  // New comment: ms-bo on pid 1, @mentioning ms-ana, day +4.
  { type: "comment", key: "ms-c6", pid: 1, email: M.bo, at: d(4, "14:00"), mentions: [M.ana] },
  // Edited comment: ms-c2 (ms-ana, pid 1) is rewritten on day +5.
  { type: "commentEdit", key: "ms-c2", at: d(5, "09:00"), words: 55 },
  // Deleted comment: ms-c5 (ms-cy, pid 3) on day +5.
  { type: "commentDelete", key: "ms-c5", at: d(5, "10:00") },
  // Unassigned review: ms-dee's empty review on pid 2, day +5.
  { type: "unassign", pid: 2, email: M.dee, at: d(5, "11:00") },
  // New AC comment on pid 3, day +6.
  { type: "comment", key: "ms-c7", pid: 3, email: M.ac, at: d(6, "10:00") },
];

export const scenario: Scenario = {
  name: "multistage",
  description: "Two stages for snapshot diffing: score change, new/edited/deleted comment, unassigned review",
  people: [
    pc(M.ac, "Mira", "Stagecoach"),
    pc(M.ana, "Ana", "Twostep", ["junior"]),
    pc(M.bo, "Bo", "Twostep"),
    pc(M.cy, "Cy", "Twostep"),
    pc(M.dee, "Dee", "Twostep", ["reciprocal"]),
  ],
  papers: [1, 2, 3].map((pid) => ({
    pid,
    title: ["Snapshot Diffing for Review Systems", "Staged Seeding of Test Conferences", "Change Detection Without Timestamps"][pid - 1]!,
    authors: [{ email: `ms-author${pid}@example.org`, first: "Ari", last: `Stageauthor${"ABC"[pid - 1]}` }],
  })),
  assignments: [
    { pid: 1, email: M.ac, role: "metareview" },
    { pid: 1, email: M.ana, role: "primary" },
    { pid: 1, email: M.bo, role: "primary" },
    { pid: 1, email: M.cy, role: "secondary" },
    { pid: 2, email: M.ac, role: "metareview" },
    { pid: 2, email: M.ana, role: "primary" },
    { pid: 2, email: M.bo, role: "primary" },
    { pid: 2, email: M.cy, role: "secondary" },
    { pid: 2, email: M.dee, role: "pcreview" },
    { pid: 3, email: M.ac, role: "metareview" },
    { pid: 3, email: M.bo, role: "primary" },
    { pid: 3, email: M.cy, role: "primary" },
    { pid: 3, email: M.dee, role: "secondary" },
  ],
  stages: [
    { name: "stage 1", now: STAGE1_NOW, events: stage1 },
    { name: "stage 2", now: STAGE2_NOW, events: stage2 },
  ],
};

export default scenario;
