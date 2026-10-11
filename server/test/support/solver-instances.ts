// Random assignment-solver instances (PLAN M10b): synthetic papers, PC
// members with tiers and affiliations, authors (some of them PC members, so
// reciprocal cycles happen), HotCRP conflicts, do-not-invite and invites
// imports, current assignments (some started), and affinity scores. Invented
// names only (@example.org).

import { intBetween, mulberry32, type Rng } from "@pcs/seed/rng";
import { DEFAULT_ASSIGNMENT_POLICY, DEFAULT_SOLVER_SETTINGS, type AssignmentPolicy, type SolverSettings } from "../../src/config.js";
import type { RevPrefRow } from "../../src/hotcrp/schemas.js";
import type { DoNotInviteRow, InviteRow } from "../../src/imports/kinds.js";
import type { AffinityScores, ScoredReviewer } from "../../src/imports/scores.js";
import type { CurrentAssignment, PaperInfo, PersonInfo } from "../../src/modules/assignment/types.js";
import type { SolverInput } from "../../src/modules/solver/types.js";

export interface InstanceOptions {
  papers: number;
  seniors: number;
  juniors: number;
  reserves: number;
  /** Fraction of (paper, reviewer) pairs with a score. */
  scored?: number;
  /** Fraction of papers that get current assignments. */
  current?: number;
  /** Distinct affiliations (smaller = more same-institution clashes). */
  affiliations?: number;
  /** Authors per paper that are PC members, at most. */
  pcAuthors?: number;
}

export interface Instance {
  input: SolverInput;
  policy: AssignmentPolicy;
  settings: SolverSettings;
}

const pick = <T>(rng: Rng, xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)]!;

/** Dense in-memory AffinityScores (same contract as imports/scores.ts). */
export function denseScores(pids: readonly number[], emails: readonly string[], cell: (p: number, e: number) => number): AffinityScores {
  const sorted = [...emails].sort();
  const pIdx = new Map(pids.map((p, i) => [p, i]));
  const eIdx = new Map(sorted.map((e, i) => [e, i]));
  const R = sorted.length;
  const cells = new Float64Array(pids.length * R);
  let pairs = 0;
  for (let p = 0; p < pids.length; p++) {
    for (let e = 0; e < R; e++) {
      const x = cell(p, e);
      cells[p * R + e] = x;
      if (!Number.isNaN(x)) pairs++;
    }
  }
  const at = (pid: number, email: string) => {
    const p = pIdx.get(pid);
    const e = eIdx.get(email.toLowerCase());
    return p === undefined || e === undefined ? -1 : p * R + e;
  };
  return {
    runs: { tpms: undefined, local: undefined },
    pids,
    emails: sorted,
    pairs,
    paperIndex: (pid) => pIdx.get(pid) ?? -1,
    reviewerIndex: (email) => eIdx.get(email.toLowerCase()) ?? -1,
    score: (pid, email) => {
      const c = at(pid, email);
      return c < 0 || Number.isNaN(cells[c]!) ? null : cells[c]!;
    },
    source: (pid, email) => {
      const c = at(pid, email);
      return c < 0 || Number.isNaN(cells[c]!) ? null : "tpms";
    },
    row: (pid) => {
      const p = pIdx.get(pid);
      return p === undefined ? undefined : cells.subarray(p * R, (p + 1) * R);
    },
    topK: (pid, k) => {
      const p = pIdx.get(pid);
      if (p === undefined) return [];
      const out: ScoredReviewer[] = [];
      for (let e = 0; e < R; e++) if (!Number.isNaN(cells[p * R + e]!)) out.push({ email: sorted[e]!, score: cells[p * R + e]!, source: "tpms" });
      return out.sort((a, b) => b.score - a.score || a.email.localeCompare(b.email)).slice(0, k);
    },
  };
}

export function randomInstance(seed: number, o: InstanceOptions): Instance {
  const rng = mulberry32(seed);
  const affs = Array.from({ length: o.affiliations ?? Math.max(3, Math.ceil((o.seniors + o.juniors + o.reserves) / 3)) }, (_, i) => `Institute ${i}`);
  const people = new Map<string, PersonInfo>();
  const add = (email: string, tier: string, extra: Partial<PersonInfo> = {}) =>
    people.set(email, { email, tier, affiliation: rng() < 0.1 ? null : pick(rng, affs), isPc: true, exempt: false, ...extra });
  const S = Array.from({ length: o.seniors }, (_, i) => `s${i}@example.org`);
  const J = Array.from({ length: o.juniors }, (_, i) => `j${i}@example.org`);
  const Rv = Array.from({ length: o.reserves }, (_, i) => `r${i}@example.org`);
  S.forEach((e) => add(e, "senior"));
  J.forEach((e) => add(e, "junior"));
  Rv.forEach((e) => add(e, "reserve-active"));
  add("ac0@example.org", "senior", { exempt: true });
  add("pool0@example.org", "reserve-pool", { isPc: false });
  const pcAuthors = [...S, ...Rv];

  const papers = new Map<number, PaperInfo>();
  const pids = Array.from({ length: o.papers }, (_, i) => i + 1);
  for (const pid of pids) {
    const authors: { email: string | null; affiliation: string | null }[] = [];
    const nPc = intBetween(rng, 0, o.pcAuthors ?? 1);
    for (let k = 0; k < nPc; k++) {
      const e = pick(rng, pcAuthors);
      if (!authors.some((a) => a.email === e)) authors.push({ email: e, affiliation: people.get(e)!.affiliation });
    }
    const nOther = intBetween(rng, 1, 2);
    for (let k = 0; k < nOther; k++) authors.push({ email: rng() < 0.9 ? `a${pid}.${k}@example.org` : null, affiliation: pick(rng, affs) });
    papers.set(pid, { pid, authors });
  }

  const reviewers = [...S, ...J, ...Rv];
  const conflicts: { pid: number; email: string }[] = [];
  for (const pid of pids) for (const e of reviewers) if (rng() < 0.02) conflicts.push({ pid, email: e });
  const dniEmails = [pick(rng, reviewers), pick(rng, reviewers)];
  const doNotInvite = { runId: 1, rows: [...new Set(dniEmails)].map((email): DoNotInviteRow => ({ email, reason: null, source: null })) };

  const invites: InviteRow[] = [];
  for (const r of Rv) {
    for (const pid of pids) {
      if (rng() > Math.min(0.25, 8 / o.papers)) continue;
      const decision = rng() < 0.8 ? "approve" : pick(rng, ["reject", "pending"] as const);
      const response = rng() < 0.9 ? "accept" : "decline";
      invites.push({
        pid,
        candidate_email: r,
        tpms_score: null,
        seniority_note: null,
        ac_email: null,
        ac_decision: decision,
        invited_at: null,
        response,
        activated_at: decision === "approve" && response === "accept" && rng() < 0.15 ? 1_900_000_000 : null,
      });
    }
  }

  const current: CurrentAssignment[] = [];
  for (const pid of pids) {
    if (rng() > (o.current ?? 0.3)) continue;
    const n = intBetween(rng, 1, 3);
    const used = new Set<string>();
    for (let k = 0; k < n; k++) {
      const e = pick(rng, reviewers);
      if (used.has(e)) continue;
      used.add(e);
      current.push({ pid, email: e, role: pick(rng, ["primary", "secondary", "pc"] as const), status: rng() < 0.3 ? "complete" : "empty" });
    }
  }
  current.sort((a, b) => a.pid - b.pid || a.email.localeCompare(b.email));
  const blocked = rng() < 0.5 ? [{ pid: 1, email: S[0]! }] : [];
  const emails = [...reviewers].sort();
  const scored = o.scored ?? 0.7;
  const scores = denseScores(pids, emails, () => (rng() < scored ? Math.round(rng() * 1000) / 1000 : NaN));
  const prefs: RevPrefRow[] = [];
  for (let k = 0; k < o.papers; k++) {
    prefs.push({ pid: pick(rng, pids), email: pick(rng, reviewers), conflict: rng() < 0.2, preference: intBetween(rng, -20, 20), expertise: pick(rng, ["X", "Y", "Z", null] as const), topicScore: 0 });
  }

  // Bands roomy enough that most instances can be staffed, tight enough to bind.
  const seniorMax = Math.max(1, Math.ceil((2 * o.papers * 1.3) / Math.max(1, o.seniors)));
  const thirdMax = Math.max(1, Math.ceil((o.papers * 1.5) / Math.max(1, o.juniors + o.reserves)));
  const policy: AssignmentPolicy = {
    ...DEFAULT_ASSIGNMENT_POLICY,
    load: {
      senior: { min: 1, max: seniorMax },
      junior: { min: 1, max: thirdMax },
      "reserve-active": { min: 0, max: Math.min(3, thirdMax) },
      "reserve-pool": { min: 0, max: 0 },
    },
  };
  const settings: SolverSettings = { ...DEFAULT_SOLVER_SETTINGS, topK: 20, repairMax: 10 };
  return {
    input: { papers, people, current, blocked, conflicts, invites: { runId: 1, rows: invites }, doNotInvite, scores, prefs },
    policy,
    settings,
  };
}
