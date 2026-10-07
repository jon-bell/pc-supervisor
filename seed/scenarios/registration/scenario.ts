// The `registration` scenario (PLAN M11): reserve compliance (spec §10.4 A)
// and the quick-reject tracker (§10.4 B) with deliberately planted problems,
// plus fixture CSVs for `pcs import` (fixtures/). expected.ts lists every
// finding and queue item the two modules must report, and nothing else.
//
// Reserve compliance (#1-#12):
//   - #1 is the clean control: designee clara.bishop, TPMS-registered;
//   - #2 names no designee and claims no exemption (DESIGNEE_MISSING);
//   - Kim Park is designated as kim.park@ on #3 and k.park@ on #4, so she is
//     the same person designated differently (DESIGNEE_INCONSISTENT); only
//     kim.park@ registered with TPMS (TPMS_NOT_REGISTERED for k.park@). #4
//     types the email in mixed case, which normalization absorbs;
//   - #5 claims the exemption "on-sabbatical", not an allowed reason
//     (EXEMPTION_NOT_ALLOWED);
//   - #6 claims "all-authors-on-pc", but one author isn't on the PC
//     (EXEMPTION_CONTRADICTED);
//   - victor.okafor is the designee of #7-#10, more than
//     PCS_RESERVE_MAX_COVER=3 (OVER_COVERED);
//   - #11 claims "no-eligible-author" (valid; the mocked DBLP lookup gives a
//     "possibly senior" hint for one author, which is a hint, not a finding);
//   - #12 names its designee by name ("Sana Iqbal"), resolved to the author.
// Quick-reject queue (#13-#21; each names its sole author as designee):
//   - #13 refcheck hit (4 hallucinated refs); its quick-reject review by
//     qr.lane is overdue; awaiting the AC;
//   - #14 AC flag + a reject verdict + #qr-ac-reject: awaiting the chair;
//   - #15 refcheck hit (0 in-field refs), desk-rejected, decision Rejected;
//   - #16 reject verdict, desk-rejected, appeal requested;
//   - #17 AC flag, desk-rejected, appeal overturned, decision cleared;
//   - #18 AC flag, AC keeps it;
//   - #19 desk-rejected but the decision was never entered (DECISION_MISSING);
//   - #20 clean control: a "keep" verdict and a clean refcheck row (not queued);
//   - #21 desk-rejected, appeal upheld, decision Rejected.
//
// Observe at reviewDue -33 d 12:00 (PCS_NOW=2029-12-30T12:00 under ci.yml),
// with REGISTRATION_ENV's quick-reject due date (reviewDue -35 d) and
// assignment date (reviewDue -21 d): the assignment phase.
//
// Everything is invented; emails are @example.org.

import {
  QUICKREJECT_ROUND,
  RESERVE_DESIGNEE_FIELD,
  RESERVE_EXEMPTION_FIELD,
  at,
  type Assignment,
  type Author,
  type Paper,
  type Person,
  type Scenario,
  type ScenarioEvent,
  type SubmissionField,
  type When,
} from "../../src/format.js";
import { resolveWhen, type PhaseContext } from "../../src/time.js";
import { formatInZone } from "@pcs/server/tz";

const e = (local: string) => `${local}@example.org`;

/** Short keys -> emails, for tests and expected.ts. */
export const R = {
  acN: e("ac.north"),
  acS: e("ac.south"),
  qr1: e("qr.lane"),
  qr2: e("qr.hale"),
  pcA: e("pc.ames"),
  pcB: e("pc.brook"),
  clara: e("clara.bishop"),
  dev: e("dev.rao"),
  elif: e("elif.kaya"),
  gil: e("gil.moran"),
  kim: e("kim.park"),
  kim2: e("k.park"),
  lior: e("lior.ben"),
  maren: e("maren.voss"),
  nils: e("nils.aberg"),
  nadia: e("nadia.fern"),
  victor: e("victor.okafor"),
  owen: e("owen.pratt"),
  rhea: e("rhea.sol"),
  sana: e("sana.iqbal"),
  tomo: e("tomo.arai"),
  aiko: e("aiko.mori"),
  bruno: e("bruno.costa"),
  cyrus: e("cyrus.vale"),
  dana: e("dana.holt"),
  emil: e("emil.strand"),
  fatima: e("fatima.zahra"),
  goran: e("goran.petrov"),
  hugo: e("hugo.lind"),
  isla: e("isla.grant"),
  co7: e("yara.quinn"),
  co8: e("zeno.marsh"),
  co9: e("una.berg"),
  co10: e("wes.tanner"),
} as const;
type Key = keyof typeof R;

const NAMES: Record<Key, [string, string, string]> = {
  acN: ["Wren", "North", "Halden University"],
  acS: ["Idris", "South", "Corvale Institute"],
  qr1: ["Tomas", "Lane", "Ostfold Technical College"],
  qr2: ["Petra", "Hale", "Marrow Bay University"],
  pcA: ["Arlo", "Ames", "Pinecrest University"],
  pcB: ["Beatriz", "Brook", "Saltmarsh Institute"],
  clara: ["Clara", "Bishop", "Elmstead University"],
  dev: ["Dev", "Rao", "Elmstead University"],
  elif: ["Elif", "Kaya", "Bosphorus Tech"],
  gil: ["Gil", "Moran", "Negev Polytechnic"],
  kim: ["Kim", "Park", "Hanseo Institute"],
  kim2: ["Kim", "Park", "Hanseo Institute"],
  lior: ["Lior", "Ben", "Carmel College"],
  maren: ["Maren", "Voss", "Hanse University"],
  nils: ["Nils", "Åberg", "Uppland University"],
  nadia: ["Nadia", "Fern", "Glenmoor University"],
  victor: ["Victor", "Okafor", "Niger Delta Institute"],
  owen: ["Owen", "Pratt", "Ridgeway University"],
  rhea: ["Rhea", "Sol", "Ridgeway University"],
  sana: ["Sana", "Iqbal", "Indus Valley University"],
  tomo: ["Tomo", "Arai", "Kanto Institute"],
  aiko: ["Aiko", "Mori", "Hokuriku University"],
  bruno: ["Bruno", "Costa", "Atlantico University"],
  cyrus: ["Cyrus", "Vale", "Zagros Institute"],
  dana: ["Dana", "Holt", "Prairie State University"],
  emil: ["Emil", "Strand", "Fjell University"],
  fatima: ["Fatima", "Zahra", "Atlas Polytechnic"],
  goran: ["Goran", "Petrov", "Balkan Tech"],
  hugo: ["Hugo", "Lind", "Skagen College"],
  isla: ["Isla", "Grant", "Highland University"],
  co7: ["Yara", "Quinn", "Okafor Lab"],
  co8: ["Zeno", "Marsh", "Okafor Lab"],
  co9: ["Una", "Berg", "Okafor Lab"],
  co10: ["Wes", "Tanner", "Okafor Lab"],
};

const PC_KEYS: readonly Key[] = ["acN", "acS", "qr1", "qr2", "pcA", "pcB"];

const person = (k: Key): Person => {
  const [first, last, affiliation] = NAMES[k];
  return { email: R[k], first, last, affiliation, roles: ["pc"], tags: [] };
};
const author = (k: Key): Author => {
  const [first, last, affiliation] = NAMES[k];
  return { email: R[k], first, last, affiliation };
};

/** The exemption dropdown with one extra, non-allowed choice (re-saving adds it, keeping M10's). */
export const EXEMPTION_FIELD_WITH_EXTRA: SubmissionField = {
  ...RESERVE_EXEMPTION_FIELD,
  values: [...(RESERVE_EXEMPTION_FIELD.values ?? []), "on-sabbatical"],
};
/** Self-declared seniority evidence (PCS_RESERVE_SENIORITY_FIELD default). */
export const RESERVE_SENIORITY_FIELD: SubmissionField = { name: "Reserve seniority", type: "text" };

const D = RESERVE_DESIGNEE_FIELD.name;
const X = RESERVE_EXEMPTION_FIELD.name;
const S = RESERVE_SENIORITY_FIELD.name;

const P = (pid: number, title: string, authors: Key[], options: Record<string, string> = {}, tags: string[] = []): Paper => ({
  pid,
  title,
  authors: authors.map(author),
  ...(Object.keys(options).length ? { options } : {}),
  ...(tags.length ? { tags } : {}),
});
const designee = (k: Key) => ({ [D]: R[k] });

/** Quick-reject state tags (the PCS_QR_TAGS defaults) and the AC flag (PCS_QR_AC_FLAG_TAG default). */
export const T = {
  flag: "qr-flag",
  acReject: "qr-ac-reject",
  acKeep: "qr-ac-keep",
  desk: "qr-chair-desk-reject",
  appeal: "qr-appeal",
  upheld: "qr-appeal-upheld",
  overturned: "qr-appeal-overturned",
} as const;

const papers: Paper[] = [
  P(1, "Typed Holes for Build Scripts", ["clara", "dev"], { ...designee("clara"), [S]: "PC member at two SE venues since 2022" }),
  P(2, "A Census of Dead Feature Flags", ["elif", "gil"]),
  P(3, "Shrinking Counterexamples for Stateful APIs", ["kim", "lior"], designee("kim")),
  P(4, "Regression Oracles from Production Traces", ["maren", "kim2"], { [D]: "K.Park@Example.ORG" }),
  P(5, "Lightweight Effect Systems for Plugins", ["nils"], { [X]: "on-sabbatical" }),
  P(6, "Commit Message Smells", ["pcA", "nadia"], { [X]: "all-authors-on-pc" }),
  P(7, "Benchmarks for Incremental Parsers", ["victor", "co7"], designee("victor")),
  P(8, "Taint Tracking for Notebook Code", ["co8", "victor"], designee("victor")),
  P(9, "Repairing Broken Docker Builds", ["victor", "co9"], designee("victor")),
  P(10, "Ownership Types in the Wild", ["co10", "victor"], designee("victor")),
  P(11, "Visualizing Merge Queues", ["owen", "rhea"], { [X]: "no-eligible-author" }),
  P(12, "Static Analysis of Shell One-Liners", ["tomo", "sana"], { [D]: "Sana Iqbal" }),
  // Quick-reject queue.
  P(13, "A Theory of Everything in Software", ["aiko"], designee("aiko"), []),
  P(14, "Untitled Draft Submission", ["bruno"], designee("bruno"), [T.flag, T.acReject]),
  P(15, "Blockchain for Unit Tests", ["cyrus"], designee("cyrus"), [T.acReject, T.desk]),
  P(16, "Prompting Compilers Politely", ["dana"], designee("dana"), [T.acReject, T.desk, T.appeal]),
  P(17, "Self-Healing Spreadsheets", ["emil"], designee("emil"), [T.flag, T.acReject, T.desk, T.appeal, T.overturned]),
  P(18, "Mutation Testing for Robots", ["fatima"], designee("fatima"), [T.flag, T.acKeep]),
  P(19, "Quantum Linting", ["goran"], designee("goran"), [T.acReject, T.desk]),
  P(20, "Faster Flaky-Test Triage", ["hugo"], designee("hugo")),
  P(21, "Code Review by Horoscope", ["isla"], designee("isla"), [T.acReject, T.desk, T.appeal, T.upheld]),
];

/** When quick-reject reviews were requested and written, relative to the review deadline. */
const QR_REQUESTED: When = at("reviewDue", -40, "09:00");
const QR_WRITTEN: When = at("reviewDue", -37, "10:00");
/** PCS_PHASE_QUICKREJECT_DUE and PCS_PHASE_ASSIGNMENT_DONE for this scenario (see REGISTRATION_ENV). */
export const QR_DUE: When = at("reviewDue", -35, "23:59");
export const ASSIGNMENT_DONE: When = at("reviewDue", -21, "23:59");
export const OBSERVE_AT: When = at("reviewDue", -33, "12:00");

/** pid -> quick-reject reviewer and verdict (merit; null = never submitted). */
export const QR_REVIEWS: readonly { pid: number; email: string; merit: number | null }[] = [
  { pid: 13, email: R.qr1, merit: null },
  { pid: 14, email: R.qr2, merit: 1 },
  { pid: 16, email: R.qr1, merit: 1 },
  { pid: 20, email: R.qr2, merit: 4 },
];

const assignments: Assignment[] = [
  ...papers.map((p): Assignment => ({ pid: p.pid, email: p.pid <= 12 ? R.acN : R.acS, role: "metareview" })),
  ...QR_REVIEWS.map((q): Assignment => ({ pid: q.pid, email: q.email, role: "pcreview", round: QUICKREJECT_ROUND, requestedAt: QR_REQUESTED })),
];

const events: ScenarioEvent[] = [
  ...QR_REVIEWS.filter((q) => q.merit !== null).map(
    (q): ScenarioEvent => ({ type: "review", at: QR_WRITTEN, pid: q.pid, email: q.email, scores: { OveMer: q.merit!, RevExp: 3 }, words: 60 }),
  ),
  ...[15, 16, 21].map((pid): ScenarioEvent => ({ type: "decision", at: at("reviewDue", -34, "12:00"), pid, decision: "Rejected" })),
];

export const scenario: Scenario = {
  name: "registration",
  description: "Reserve compliance (missing, inconsistent, over-covered designees; bad exemptions) and a quick-reject queue in every state",
  people: PC_KEYS.map(person),
  papers,
  assignments,
  submissionFields: [RESERVE_DESIGNEE_FIELD, EXEMPTION_FIELD_WITH_EXTRA, RESERVE_SENIORITY_FIELD],
  reviewRounds: [QUICKREJECT_ROUND],
  stages: [{ name: "quick-reject done", now: OBSERVE_AT, events }],
};

/** Fixture CSVs for `pcs import`, relative to this directory. */
export const FIXTURES = {
  "tpms-registrations": new URL("./fixtures/tpms-registrations.csv", import.meta.url),
  refcheck: new URL("./fixtures/refcheck.csv", import.meta.url),
} as const;

/**
 * The mocked DBLP table the tests use (no test calls the network): Owen Pratt
 * looks senior, Victor Okafor doesn't reach PCS_DBLP_SENIOR_MIN=5.
 */
export const DBLP_MOCK = {
  "Owen Pratt": { venues: { ICSE: 5, "ESEC/SIGSOFT FSE": 2 }, matchedPapers: 15 },
  "Victor Okafor": { venues: { ICSE: 2 }, matchedPapers: 6 },
} as const;

/** A When as a PCS_PHASE_* value (local ISO date-time in PCS_TZ). */
export function phaseEnvValue(w: When, ctx: PhaseContext): string {
  return formatInZone(resolveWhen(w, ctx), ctx.tz).slice(0, 16);
}

/**
 * Env the scenario is designed for, on top of the ci.yml phase dates: the
 * quick-reject due date and assignment date relative to the review deadline
 * (so no date is hard-coded). Everything else keeps its default.
 */
export function registrationEnv(ctx: PhaseContext): Record<string, string> {
  return {
    PCS_PHASE_QUICKREJECT_DUE: phaseEnvValue(QR_DUE, ctx),
    PCS_PHASE_ASSIGNMENT_DONE: phaseEnvValue(ASSIGNMENT_DONE, ctx),
  };
}
