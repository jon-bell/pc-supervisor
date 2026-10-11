// The assignment network and its repair loop (spec §10.5, PLAN M10b).
//
// Network (one min-cost flow over M10a's MinCostMaxFlow):
//
//   source --(cap c_r)--> R_r --(c_r unit edges, convex cost)--> L_r --(cap 1, -affinity)--> p.senior | p.third
//   R_r --(cap c_r, cost 0)--> sink                                  (bypass: unused capacity)
//   p.senior --(cap MIN_SENIOR, -SLOT_BONUS)--> p   + --(cap MAX_SENIOR - MIN_SENIOR, 0)--> p
//   p.third  --(cap 1, -SLOT_BONUS)--> p
//   p --(cap = the sum of the above)--> sink
//
// - c_r is the reviewer's band maximum (PCS_LOAD_<TIER>_MAX), raised to their
//   pinned count if pins exceed it. The i-th unit edge R_r -> L_r costs
//   (i-1) x PCS_SOLVER_LOAD_COST (HotCRP's convex load cost), minus
//   PCS_SOLVER_LOAD_MIN_BONUS while i <= the band minimum.
// - The bypass makes the maximum flow trivially sum(c_r), so the max-flow
//   phase never forces extra assignments: what gets assigned is decided by
//   cost alone (affinity, load, and the bonuses).
// - Soft (default): each required slot is an edge with cost -PCS_SOLVER_SLOT_BONUS,
//   so filling it beats any affinity or load cost and the solve always
//   succeeds; slots that stay empty are reported per paper. Hard
//   (PCS_SOLVER_HARD): the required edges get lower bounds instead, and an
//   unstaffable paper makes the whole solve infeasible (reported via `unmet`).
// - Junior and reserve-active reviewers (every non-senior tier) feed p.third.
// - An edge L_r -> p.t exists only if r is eligible for p: an assignable PC
//   member (not a chair/AC, tier with a band), not an author of p, not
//   conflicted in HotCRP (get/pcconf; allrevpref conflicts too), not sharing
//   an affiliation with an author (PCS_CONFLICT_AFFILIATION), not on the
//   do-not-invite import, and, for a reserve-* tier, approved for p in the
//   invites import (ac_decision=approve, response != decline).
// - Pruning: per paper and slot class, the PCS_SOLVER_TOPK best eligible
//   candidates by affinity (ties by a hash of pid and reviewer, so unscored
//   candidates spread out), plus every current unstarted assignment that is
//   still eligible, plus every pinned edge.
// - Pinned (lower bound 1): started reviews (status not in the validator's
//   CLEARABLE_STATUSES), and AC-activated reserves (invites: approve, not
//   declined, activated_at set). A pin that is itself ineligible is kept and
//   reported as a pin issue (a started review), or dropped and reported (a
//   reserve activation that is conflicted or on do-not-invite).
//
// Repair passes (each round: detect, forbid, re-solve):
// - reciprocal cycles: M10's findCycles on the solved author -> reviewer
//   graph; per cycle, the person edge author -> reviewer whose assignments
//   have the lowest total affinity (and no pin) is forbidden: the reviewer
//   loses those assignments and every candidate edge onto that author's
//   papers, so the pair can't close the cycle again elsewhere;
// - one reviewer per institution per paper (PCS_SOLVER_ONE_PER_INSTITUTION):
//   per paper, the pinned or best-scoring reviewer of an affiliation stays and
//   every other candidate from it is forbidden on that paper.
// Re-solves are warm: only the papers that lost an assignment are solved
// again, with every other paper's assignment fixed (its reviewers' load is
// carried over, so bands and convex costs stay exact). That takes
// milliseconds instead of a full solve per round. Rounds repeat until both
// checks are clean or PCS_SOLVER_REPAIR_MAX rounds have run; what is left is
// reported as unresolved. Finally one full solve with every forbidden edge
// removed ("polish") replaces the result if it is cheaper and introduces no
// new cycle or clash.
//
// The network follows HotCRP's autoassigner (src/autoassigner.php,
// hotcrp@60f693f8, Copyright (c) 2006-2025 Eddie Kohler; MIT-style license,
// see mcmf.ts for the full notice): reviewers fed from the source with
// convex per-assignment load costs, cost-weighted reviewer -> paper edges,
// and paper -> sink capacities. The tier gadget, bypass, pins, and repairs
// are ours; no autoassigner code is copied line for line.

import { LOAD_TIERS, type AssignmentPolicy, type LoadTier, type SolverSettings } from "../../config.js";
import { findCycles } from "../assignment/cycles.js";
import type { CurrentAssignment, Finding, ProposedRow, ValidatorInput } from "../assignment/types.js";
import { CLEARABLE_STATUSES, RESERVE_TIERS, normalizeAffiliation, validate } from "../assignment/validate.js";
import { AffinityTable } from "./affinity.js";
import { MinCostMaxFlow } from "./mcmf.js";
import type {
  CrossCheckFinding,
  CsvLine,
  LoadBandReport,
  PinIssue,
  Repair,
  SlotClass,
  SolvedAssignment,
  SolveReport,
  SolverInput,
  UnmetRequirement,
  Unresolved,
  WeakCoverage,
} from "./types.js";

const LOAD_TIER_NAMES: ReadonlySet<string> = new Set(LOAD_TIERS.map(([t]) => t));
const ROLE_ACTION = { primary: "primary", secondary: "secondary", pc: "pcreview" } as const;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

interface Reviewer {
  idx: number;
  email: string;
  tier: string;
  cls: SlotClass;
  band: { min: number; max: number } | null;
  /** Can get new assignments (PC, not chair/AC, a tier with a band max > 0). */
  assignable: boolean;
  aff: string;
}

interface AEdge {
  e: number;
  pid: number;
  r: number;
  aff: number;
  raw: number;
  source: SolvedAssignment["source"];
  pinned: SolvedAssignment["pinned"];
}

type PinWhy = Exclude<SolvedAssignment["pinned"], null>;

/** Deterministic tie-break hash so equal (e.g. unscored) candidates don't all go to the alphabetically first reviewer. */
function mix(pid: number, r: number): number {
  let h = Math.imul(pid ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(r + 0x632be5ab, 0xc2b2ae35);
  h ^= h >>> 13;
  h = Math.imul(h, 0x27d4eb2d);
  return (h ^ (h >>> 15)) >>> 0;
}

function bandOf(tier: string, policy: AssignmentPolicy): { min: number; max: number } | null {
  return LOAD_TIER_NAMES.has(tier) ? policy.load[tier as LoadTier] : null;
}

const setMap = () => new Map<number, Set<string>>();
function addTo(m: Map<number, Set<string>>, pid: number, email: string) {
  let s = m.get(pid);
  if (!s) m.set(pid, (s = new Set()));
  s.add(email);
}

export interface SolveOptions {
  /** Overrides settings.hard (the CLI's --hard). */
  hard?: boolean;
}

/** Build the network, solve it, run the repair passes, and report (see the file comment). */
export function solve(input: SolverInput, policy: AssignmentPolicy, settings: SolverSettings, opts: SolveOptions = {}): SolveReport {
  const t0 = performance.now();
  const hard = opts.hard ?? settings.hard;
  const notes: string[] = [];
  const pids = [...input.papers.keys()].sort((a, b) => a - b);
  const maxSenior = Math.max(settings.maxSenior, policy.minSenior);

  // --- Eligibility sets -----------------------------------------------------
  const authors = setMap();
  const authorAff = setMap();
  for (const p of input.papers.values()) {
    for (const a of p.authors) {
      if (a.email) addTo(authors, p.pid, a.email);
      const n = normalizeAffiliation(a.affiliation);
      if (n !== "") addTo(authorAff, p.pid, n);
    }
  }
  const conflicts = setMap();
  for (const c of input.conflicts) addTo(conflicts, c.pid, c.email.toLowerCase());
  for (const c of input.prefs ?? []) if (c.conflict) addTo(conflicts, c.pid, c.email);
  const blocked = setMap();
  for (const b of input.blocked) addTo(blocked, b.pid, b.email);
  const dni = new Set((input.doNotInvite?.rows ?? []).map((r) => r.email));
  const approved = setMap();
  const activated: { pid: number; email: string }[] = [];
  for (const r of input.invites?.rows ?? []) {
    if (r.ac_decision !== "approve" || r.response === "decline") continue;
    addTo(approved, r.pid, r.candidate_email);
    if (r.activated_at !== null) activated.push({ pid: r.pid, email: r.candidate_email });
  }

  /** Why r can't review pid (null = eligible), ignoring assignability. */
  const ineligible = (pid: number, rv: Reviewer): string | null => {
    const e = rv.email;
    if (authors.get(pid)?.has(e)) return `${e} is an author of #${pid}`;
    if (conflicts.get(pid)?.has(e)) return `${e} has a HotCRP conflict with #${pid}`;
    if (policy.affiliationConflicts && rv.aff !== "" && authorAff.get(pid)?.has(rv.aff)) {
      return `${e} shares an affiliation with an author of #${pid} (PCS_CONFLICT_AFFILIATION=true)`;
    }
    if (dni.has(e)) return `${e} is on the do-not-invite list (import #${input.doNotInvite!.runId})`;
    if (RESERVE_TIERS.has(rv.tier) && !approved.get(pid)?.has(e)) {
      return `reserve candidate ${e} is not AC-approved for #${pid} in the ${input.invites ? `invites import #${input.invites.runId}` : "invites import (none yet)"}`;
    }
    return null;
  };

  // --- Reviewers ------------------------------------------------------------
  const reviewers: Reviewer[] = [];
  const revIndex = new Map<string, number>();
  const addReviewer = (email: string): number => {
    const known = revIndex.get(email);
    if (known !== undefined) return known;
    const p = input.people.get(email);
    const tier = p?.tier ?? "senior";
    const band = bandOf(tier, policy);
    const rv: Reviewer = {
      idx: reviewers.length,
      email,
      tier,
      cls: tier === "senior" ? "senior" : "third",
      band,
      assignable: !!p && p.isPc && !p.exempt && band !== null && band.max > 0,
      aff: normalizeAffiliation(p?.affiliation),
    };
    reviewers.push(rv);
    revIndex.set(email, rv.idx);
    return rv.idx;
  };
  const customTiers = new Set<string>();
  for (const p of [...input.people.values()].sort((a, b) => a.email.localeCompare(b.email))) {
    if (!p.isPc || p.exempt) continue;
    if (!LOAD_TIER_NAMES.has(p.tier)) customTiers.add(p.tier);
    addReviewer(p.email);
  }
  if (customTiers.size > 0) {
    notes.push(`tier(s) ${[...customTiers].sort().join(", ")} have no PCS_LOAD_* band, so their members get no new assignments`);
  }

  // --- Pins and current assignments ----------------------------------------
  const pinIssues: PinIssue[] = [];
  const pins = new Map<number, Map<number, PinWhy>>(); // pid -> r -> why
  const pin = (pid: number, r: number, why: PinWhy) => {
    let m = pins.get(pid);
    if (!m) pins.set(pid, (m = new Map()));
    if (!m.has(r)) m.set(r, why);
  };
  const currentBy = new Map<number, Map<number, CurrentAssignment>>();
  for (const c of input.current) {
    if (!input.papers.has(c.pid)) continue;
    const r = addReviewer(c.email);
    let m = currentBy.get(c.pid);
    if (!m) currentBy.set(c.pid, (m = new Map()));
    m.set(r, c);
    const started = c.status !== null && !CLEARABLE_STATUSES.has(c.status);
    const rv = reviewers[r]!;
    if (started) {
      pin(c.pid, r, "started");
      const why = ineligible(c.pid, rv) ?? (rv.assignable ? null : `${c.email} is not an assignable PC member`);
      if (why) pinIssues.push({ pid: c.pid, email: c.email, reason: `kept: review already ${c.status}, although ${why}` });
    } else if (!rv.assignable && input.people.get(c.email)?.exempt) {
      // A chair or AC the chair placed as a reviewer: keep it, never add more.
      pin(c.pid, r, "exempt");
    }
  }
  for (const a of activated) {
    if (!input.papers.has(a.pid)) continue;
    const p = input.people.get(a.email);
    const where = `invites import #${input.invites!.runId}`;
    if (!p || !p.isPc) {
      pinIssues.push({ pid: a.pid, email: a.email, reason: `activated reserve ${a.email} on #${a.pid} (${where}) is not a PC member yet; add them to the PC first` });
      continue;
    }
    const r = addReviewer(a.email);
    if (pins.get(a.pid)?.has(r)) continue;
    const why = ineligible(a.pid, reviewers[r]!) ?? (reviewers[r]!.assignable ? null : `${a.email} has no review-load band (tier ${reviewers[r]!.tier})`);
    if (why) {
      pinIssues.push({ pid: a.pid, email: a.email, reason: `activated reserve on #${a.pid} (${where}) not pinned: ${why}` });
      continue;
    }
    pin(a.pid, r, "reserve");
  }

  // --- Candidates (computed once) -------------------------------------------
  const table = new AffinityTable(
    reviewers.map((r) => r.email),
    input.scores,
    input.prefs,
    settings,
  );
  const pinnedLoad = new Int32Array(reviewers.length);
  for (const m of pins.values()) for (const r of m.keys()) pinnedLoad[r]!++;
  const cap = reviewers.map((rv) => Math.max(rv.assignable ? rv.band!.max : 0, pinnedLoad[rv.idx]!));
  const bandMin = reviewers.map((rv) => (rv.assignable ? rv.band!.min : 0));

  const aedges: AEdge[] = [];
  const edgeOf = new Map<number, number>(); // pid * 2^20 + r -> aedges index
  const pairKey = (pid: number, r: number) => pid * 1_048_576 + r;
  const eligibleCount = new Map<number, { senior: number; third: number }>();
  const paperEdges = new Map<number, { from: number; to: number; sCap: number; tCap: number }>();
  const coverage: WeakCoverage[] = [];
  let candidates = 0;
  let scoredAny = false;

  for (const pid of pids) {
    const aff = table.forPaper(pid);
    const pm = pins.get(pid);
    const cur = currentBy.get(pid);
    const bl = blocked.get(pid);
    const lists: Record<SlotClass, { r: number; a: ReturnType<typeof aff>; h: number }[]> = { senior: [], third: [] };
    const best: Record<SlotClass, number | null> = { senior: null, third: null };
    for (const rv of reviewers) {
      if (!rv.assignable || pm?.has(rv.idx) || bl?.has(rv.email)) continue;
      if (ineligible(pid, rv) !== null) continue;
      const a = aff(rv.idx);
      if (!Number.isNaN(a.raw)) {
        scoredAny = true;
        const b = best[rv.cls];
        if (b === null || a.raw > b) best[rv.cls] = a.raw;
      }
      lists[rv.cls].push({ r: rv.idx, a, h: mix(pid, rv.idx) });
    }
    eligibleCount.set(pid, { senior: lists.senior.length, third: lists.third.length });
    const weakS = policy.minSenior > 0 && (best.senior === null || best.senior < settings.weakAffinity);
    const weakT = best.third === null || best.third < settings.weakAffinity;
    if (weakS || weakT) {
      const show = (b: number | null, w: string) => (b === null ? `no scored ${w} candidate` : `best ${w} candidate scores ${b.toFixed(2)}`);
      coverage.push({
        pid,
        bestSenior: best.senior,
        bestThird: best.third,
        reason: `#${pid}: ${show(best.senior, "senior")}, ${show(best.third, "third-slot")} (PCS_SOLVER_WEAK_AFFINITY=${settings.weakAffinity})`,
      });
    }
    const from = aedges.length;
    const add = (r: number, a: ReturnType<typeof aff>, pinned: AEdge["pinned"]) => {
      edgeOf.set(pairKey(pid, r), aedges.length);
      aedges.push({ e: -1, pid, r, aff: a.value, raw: a.raw, source: a.source, pinned });
    };
    let pinS = 0;
    let pinT = 0;
    for (const [r, why] of [...(pm ?? new Map<number, PinWhy>())].sort((x, y) => x[0] - y[0])) {
      add(r, aff(r), why);
      if (reviewers[r]!.cls === "senior") pinS++;
      else pinT++;
    }
    for (const cls of ["senior", "third"] as const) {
      const l = lists[cls];
      l.sort((x, y) => y.a.value - x.a.value || x.h - y.h || x.r - y.r);
      const keep = new Set<number>();
      for (let i = 0; i < l.length && i < settings.topK; i++) keep.add(i);
      // Current (unstarted) assignments stay candidates even if pruned away.
      if (cur) l.forEach((c, i) => cur.has(c.r) && keep.add(i));
      for (const i of [...keep].sort((x, y) => x - y)) {
        add(l[i]!.r, l[i]!.a, null);
        candidates++;
      }
    }
    paperEdges.set(pid, { from, to: aedges.length, sCap: Math.max(maxSenior, pinS), tCap: Math.max(1, pinT) });
  }
  if (!scoredAny) notes.push("no affinity scores for any eligible pair (no tpms-scores / affinity-local import, no HotCRP preferences): candidates are ranked by a deterministic hash");
  const buildMs = performance.now() - t0;

  // --- Network --------------------------------------------------------------
  // Built for a set of papers; the other papers' assignments are fixed and
  // only count as reviewer load (`fixed`). The full solve uses every paper;
  // repair rounds re-solve only the papers they touched (a warm re-solve:
  // everything else stays as it was).
  const forbidden = new Uint8Array(aedges.length);
  let nodes = 0;
  let edges = 0;
  const solveMs: number[] = [];
  type Solved = { feasible: boolean; chosen: Uint8Array; unmet: { pid: number; slot: SlotClass; amount: number }[]; unmetOther: number };
  const solveFor = (subset: readonly number[], fixed: Int32Array): Solved => {
    const g = new MinCostMaxFlow();
    const lnode = new Int32Array(reviewers.length).fill(-1);
    for (const rv of reviewers) {
      const f = fixed[rv.idx]!;
      const c = cap[rv.idx]! - f;
      if (c <= 0) continue;
      const R = g.addNode();
      const L = g.addNode();
      lnode[rv.idx] = L;
      g.addEdge(g.source, R, c, 0);
      g.addEdge(R, g.sink, c, 0);
      for (let i = f + 1; i <= cap[rv.idx]!; i++) g.addEdge(R, L, 1, settings.loadCost * (i - 1) - (i <= bandMin[rv.idx]! ? settings.loadMinBonus : 0));
    }
    const slotNode = new Map<number, { pid: number; slot: SlotClass }>();
    for (const pid of subset) {
      const pe = paperEdges.get(pid)!;
      const P = g.addNode();
      const S = g.addNode();
      const T = g.addNode();
      slotNode.set(S, { pid, slot: "senior" });
      slotNode.set(T, { pid, slot: "third" });
      for (let x = pe.from; x < pe.to; x++) {
        const a = aedges[x]!;
        const L = lnode[a.r]!;
        if (forbidden[x] || L < 0) {
          a.e = -1;
          continue;
        }
        a.e = g.addEdge(L, reviewers[a.r]!.cls === "senior" ? S : T, 1, -a.aff, a.pinned ? 1 : 0);
      }
      // Tier gadget.
      if (policy.minSenior > 0) {
        if (hard) g.addEdge(S, P, policy.minSenior, 0, policy.minSenior);
        else g.addEdge(S, P, policy.minSenior, -settings.slotBonus);
      }
      if (pe.sCap > policy.minSenior) g.addEdge(S, P, pe.sCap - policy.minSenior, 0);
      if (hard) g.addEdge(T, P, 1, 0, 1);
      else g.addEdge(T, P, 1, -settings.slotBonus);
      if (pe.tCap > 1) g.addEdge(T, P, pe.tCap - 1, 0);
      g.addEdge(P, g.sink, pe.sCap + pe.tCap, 0);
    }
    nodes = Math.max(nodes, g.nodeCount);
    edges = Math.max(edges, g.edgeCount);
    const t = performance.now();
    const r = g.solve();
    solveMs.push(performance.now() - t);
    const chosen = new Uint8Array(aedges.length);
    if (r.feasible) {
      for (const pid of subset) {
        const pe = paperEdges.get(pid)!;
        for (let x = pe.from; x < pe.to; x++) if (aedges[x]!.e >= 0 && r.flows[aedges[x]!.e] === 1) chosen[x] = 1;
      }
    }
    const unmet: Solved["unmet"] = [];
    let unmetOther = 0;
    for (const u of r.unmet) {
      const n = slotNode.get(u.node);
      if (n) unmet.push({ pid: n.pid, slot: n.slot, amount: u.amount });
      else unmetOther++;
    }
    return { feasible: r.feasible, chosen, unmet, unmetOther };
  };
  const noneFixed = new Int32Array(reviewers.length);
  const first = solveFor(pids, noneFixed);
  let chosen = first.chosen;

  // --- Repair loop ----------------------------------------------------------
  const repairs: Repair[] = [];
  const unresolved: Unresolved[] = [];
  const forbiddenBy = new Map<number, number>(); // pid -> count forbidden
  const assignedOf = (ch: Uint8Array) => aedges.filter((_, x) => ch[x] === 1);

  const ctx: RepairContext = {
    aedges,
    byPid: (() => {
      const m = new Map<number, number[]>();
      for (const [pid, pe] of paperEdges) m.set(pid, Array.from({ length: pe.to - pe.from }, (_, i) => pe.from + i));
      return m;
    })(),
    authored: (() => {
      const m = new Map<string, number[]>();
      for (const p of input.papers.values()) for (const a of p.authors) if (a.email) (m.get(a.email) ?? m.set(a.email, []).get(a.email)!).push(p.pid);
      return m;
    })(),
    edgeOf,
    pairKey,
    reviewers,
  };
  if (first.feasible) {
    const stuck = new Set<string>(); // issues that can't be fixed (pins only), reported once
    for (let round = 1; ; round++) {
      const issues = detectIssues(assignedOf(chosen), input, reviewers, policy, settings);
      const fresh = issues.filter((i) => !stuck.has(i.key));
      if (fresh.length === 0) break;
      if (round > settings.repairMax) {
        for (const i of fresh) unresolved.push({ kind: i.kind, pids: i.pids, emails: i.emails, reason: `${i.reason}; still present after PCS_SOLVER_REPAIR_MAX=${settings.repairMax} repair rounds` });
        break;
      }
      const toForbid: { idx: number[]; repair: Repair }[] = [];
      const taken = new Set<number>();
      const pending: Issue[] = [];
      for (const i of fresh) {
        const choice = i.choose(ctx);
        if (choice === null) {
          stuck.add(i.key);
          unresolved.push({ kind: i.kind, pids: i.pids, emails: i.emails, reason: `${i.reason}; every assignment that could break it is pinned` });
          continue;
        }
        pending.push(i);
        const rm = choice.removed.filter((x) => !taken.has(x));
        if (rm.length === 0) continue; // already broken by another forbid this round
        const idx = [...rm, ...choice.also.filter((x) => !taken.has(x))];
        idx.forEach((x) => taken.add(x));
        const removed = rm.map((x) => ({ pid: aedges[x]!.pid, email: reviewers[aedges[x]!.r]!.email, affinity: aedges[x]!.aff }));
        const more = idx.length - rm.length;
        toForbid.push({
          idx,
          repair: {
            round,
            kind: i.kind,
            removed,
            forbidden: idx.length,
            reason:
              `${i.reason}; removed ${removed.map((x) => `${x.email} from #${x.pid} (affinity ${x.affinity})`).join(", ")}` +
              (more > 0 ? ` and forbade ${plural(more, "more candidate edge")} that would recreate it` : ""),
          },
        });
      }
      if (toForbid.length === 0) continue; // only stuck issues left: the next round finds nothing new and stops
      for (const f of toForbid) for (const x of f.idx) forbidden[x] = 1;
      // Warm re-solve: only the papers that lost an assignment; the rest stay fixed.
      const touched = [...new Set(toForbid.flatMap((f) => f.idx.filter((x) => chosen[x]).map((x) => aedges[x]!.pid)))].sort((a, b) => a - b);
      const inTouched = new Set(touched);
      const fixed = new Int32Array(reviewers.length);
      for (let x = 0; x < aedges.length; x++) if (chosen[x] && !inTouched.has(aedges[x]!.pid)) fixed[aedges[x]!.r]!++;
      let next = solveFor(touched, fixed);
      if (next.feasible) {
        for (let x = 0; x < aedges.length; x++) if (chosen[x] && !inTouched.has(aedges[x]!.pid)) next.chosen[x] = 1;
      } else {
        // Hard mode only: the touched papers can't be restaffed around the fixed rest; try a full solve.
        next = solveFor(pids, noneFixed);
      }
      if (!next.feasible) {
        // Undo this round, keep the last feasible solution, and report what is left.
        for (const f of toForbid) for (const x of f.idx) forbidden[x] = 0;
        for (const i of pending) {
          unresolved.push({ kind: i.kind, pids: i.pids, emails: i.emails, reason: `${i.reason}; not repaired: forbidding these assignments makes the hard solve (PCS_SOLVER_HARD=true) infeasible` });
        }
        break;
      }
      for (const f of toForbid) {
        repairs.push(f.repair);
        for (const x of f.idx) forbiddenBy.set(aedges[x]!.pid, (forbiddenBy.get(aedges[x]!.pid) ?? 0) + 1);
      }
      chosen = next.chosen;
    }
  }

  /** The network cost of an assignment (load costs - affinity - bonuses), and the same without bonuses. */
  function costs(rows: readonly AEdge[]): { objective: number; affinityObjective: number } {
    const load = new Int32Array(reviewers.length);
    const perPaper = new Map<number, { s: number; t: number }>();
    let aff = 0;
    for (const a of rows) {
      load[a.r]!++;
      aff += a.aff;
      const pp = perPaper.get(a.pid) ?? perPaper.set(a.pid, { s: 0, t: 0 }).get(a.pid)!;
      if (reviewers[a.r]!.cls === "senior") pp.s++;
      else pp.t++;
    }
    let loadSum = 0;
    let bonus = 0;
    for (const rv of reviewers) {
      const n = load[rv.idx]!;
      loadSum += (settings.loadCost * n * (n - 1)) / 2;
      bonus += settings.loadMinBonus * Math.min(n, bandMin[rv.idx]!);
    }
    if (!hard) for (const pp of perPaper.values()) bonus += settings.slotBonus * (Math.min(pp.s, policy.minSenior) + Math.min(pp.t, 1));
    return { affinityObjective: loadSum - aff, objective: loadSum - aff - bonus };
  }

  // Polish: once repairs are done, one full solve with every forbidden edge
  // gone. Taken if it is cheaper and creates no new cycle or clash.
  if (first.feasible && repairs.length > 0) {
    const polish = solveFor(pids, noneFixed);
    if (polish.feasible) {
      const rows = assignedOf(polish.chosen);
      const known = new Set(unresolved.map((u) => `${u.kind}:${u.emails.join(" ")}`));
      const fresh = detectIssues(rows, input, reviewers, policy, settings).filter((i) => !known.has(`${i.kind}:${i.emails.join(" ")}`));
      if (fresh.length === 0 && costs(rows).objective < costs(assignedOf(chosen)).objective) {
        chosen = polish.chosen;
        notes.push("after the repairs, a full re-solve without the forbidden edges found a cheaper assignment with no new cycle or clash; it is the one reported");
      }
    }
  }

  // --- Outputs --------------------------------------------------------------
  const feasible = first.feasible;
  const assigned = feasible ? assignedOf(chosen) : [];
  const byPid = new Map<number, AEdge[]>();
  for (const a of assigned) (byPid.get(a.pid) ?? byPid.set(a.pid, []).get(a.pid)!).push(a);

  const unmet: UnmetRequirement[] = [];
  if (!feasible) {
    for (const u of first.unmet) {
      const need = u.slot === "senior" ? policy.minSenior : 1;
      const el = eligibleCount.get(u.pid)![u.slot];
      unmet.push({
        pid: u.pid,
        slot: u.slot,
        have: 0,
        need,
        eligible: el,
        reason: `#${u.pid}: the hard lower bound of ${need} ${u.slot === "senior" ? "senior reviews (PCS_POLICY_MIN_SENIOR)" : "third-slot review"} can't be met (${u.amount} short, ${plural(el, "eligible candidate")}); PCS_SOLVER_HARD=true makes the whole solve infeasible`,
      });
    }
    if (first.unmetOther > 0) notes.push(`hard solve infeasible at ${first.unmetOther} vertex/vertices not tied to a paper slot`);
  } else {
    for (const pid of pids) {
      const rows = byPid.get(pid) ?? [];
      const s = rows.filter((a) => reviewers[a.r]!.cls === "senior").length;
      const t = rows.length - s;
      const el = eligibleCount.get(pid)!;
      const fb = forbiddenBy.get(pid) ?? 0;
      const pinnedIn = (cls: SlotClass) => rows.filter((a) => a.pinned && reviewers[a.r]!.cls === cls).length;
      const why = (cls: SlotClass, need: number, eligible: number, stem: string) => {
        if (eligible + pinnedIn(cls) < need) return `only ${plural(eligible, "eligible candidate")} after conflicts, do-not-invite, and reserve approval`;
        const extra = fb > 0 ? `; repairs forbade ${plural(fb, "candidate edge")} of this paper` : "";
        return `${plural(eligible, "eligible candidate")}, but their load bands (${stem}) are used by other papers${extra}`;
      };
      if (s < policy.minSenior) {
        unmet.push({ pid, slot: "senior", have: s, need: policy.minSenior, eligible: el.senior, reason: `#${pid} has ${s} of PCS_POLICY_MIN_SENIOR=${policy.minSenior} senior reviewers: ${why("senior", policy.minSenior, el.senior, "PCS_LOAD_SENIOR_MAX")}` });
      }
      if (t < 1) {
        unmet.push({ pid, slot: "third", have: t, need: 1, eligible: el.third, reason: `#${pid} has no third-slot (junior/reserve) reviewer (PCS_POLICY_THIRD_SLOT=${policy.thirdSlot}): ${why("third", 1, el.third, "PCS_LOAD_JUNIOR_MAX / PCS_LOAD_RESERVE_ACTIVE_MAX")}` });
      }
    }
  }

  const solved: SolvedAssignment[] = [];
  const lines: CsvLine[] = [];
  const cleared: { pid: number; email: string }[] = [];
  const round = settings.round ?? "";
  for (const pid of pids) {
    const rows = (byPid.get(pid) ?? []).slice();
    const cur = currentBy.get(pid);
    const keep = new Set(rows.map((a) => a.r));
    for (const [r, c] of [...(cur ?? new Map<number, CurrentAssignment>())].sort((x, y) => reviewers[x[0]]!.email.localeCompare(reviewers[y[0]]!.email))) {
      if (keep.has(r) || !feasible) continue;
      cleared.push({ pid, email: c.email });
      lines.push({ pid, action: "clearreview", email: c.email, round: "" });
    }
    const order = (a: AEdge, b: AEdge) => b.aff - a.aff || reviewers[a.r]!.email.localeCompare(reviewers[b.r]!.email);
    for (const cls of ["senior", "third"] as const) {
      for (const a of rows.filter((x) => reviewers[x.r]!.cls === cls).sort(order)) {
        const rv = reviewers[a.r]!;
        const c = cur?.get(a.r);
        const action = c ? ROLE_ACTION[c.role] : cls === "senior" ? "primary" : "secondary";
        solved.push({ pid, email: rv.email, tier: rv.tier, slot: cls, action, pinned: a.pinned, current: !!c, affinity: a.aff, source: a.source });
        lines.push({ pid, action, email: rv.email, round: c ? "" : round });
      }
    }
  }
  const csv = ["paper,action,email,round", ...lines.map((l) => `${l.pid},${l.action},${l.email},${l.round}`)].join("\n") + "\n";

  // Load histogram by tier (PC members who aren't chairs/ACs, as in M10's load check).
  const loads = new Map<string, number>();
  for (const a of solved) loads.set(a.email, (loads.get(a.email) ?? 0) + 1);
  const tiers = new Map<string, LoadBandReport & { hist: Map<number, number> }>();
  for (const p of input.people.values()) {
    if (!p.isPc || p.exempt) continue;
    let t = tiers.get(p.tier);
    if (!t) tiers.set(p.tier, (t = { tier: p.tier, band: bandOf(p.tier, policy), reviewers: 0, histogram: [], under: 0, over: 0, hist: new Map() }));
    const n = loads.get(p.email) ?? 0;
    t.reviewers++;
    t.hist.set(n, (t.hist.get(n) ?? 0) + 1);
    if (t.band && n < t.band.min) t.under++;
    if (t.band && n > t.band.max) t.over++;
  }
  const tierOrder = (x: string) => {
    const i = LOAD_TIERS.findIndex(([t]) => t === x);
    return i < 0 ? 100 : i;
  };
  const load: LoadBandReport[] = [...tiers.values()]
    .sort((a, b) => tierOrder(a.tier) - tierOrder(b.tier) || a.tier.localeCompare(b.tier))
    .map(({ hist, ...t }) => ({ ...t, histogram: [...hist].sort((a, b) => a[0] - b[0]).map(([l, n]) => ({ load: l, reviewers: n })) }));

  const { affinityObjective, objective: cost } = costs(assigned);
  const objective = feasible ? cost : 0;

  // Cross-check with M10's validator.
  const pinnedPairs = new Set(solved.filter((a) => a.pinned).map((a) => `${a.pid}\t${a.email}`));
  const vInput: ValidatorInput = {
    source: "solver",
    papers: input.papers,
    people: input.people,
    proposal: solved.map((a): ProposedRow => ({ pid: a.pid, email: a.email, score: a.affinity })),
    current: input.current,
    invites: input.invites,
    doNotInvite: input.doNotInvite,
  };
  const vr = validate(vInput, policy);
  const unmetKey = new Set(unmet.map((u) => `${u.pid}\t${u.slot}`));
  const unresolvedCycles = new Set(unresolved.filter((u) => u.kind === "cycle").map((u) => [...u.emails].sort().join(" ")));
  const pinnedPerPaperThird = new Map<number, number>();
  for (const a of solved) if (a.pinned && a.slot === "third") pinnedPerPaperThird.set(a.pid, (pinnedPerPaperThird.get(a.pid) ?? 0) + 1);
  const explain = (f: Finding): string | null => {
    switch (f.code) {
      case "ALL_JUNIOR_PANEL":
      case "SENIOR_MISSING":
        return unmetKey.has(`${f.pid}\tsenior`) ? "reported as unmet (senior)" : null;
      case "THIRD_SLOT_MISSING":
        return unmetKey.has(`${f.pid}\tthird`) ? "reported as unmet (third slot)" : null;
      case "THIRD_SLOT_EXTRA":
        return (pinnedPerPaperThird.get(f.pid!) ?? 0) > 1 ? "several third-slot reviews are pinned" : null;
      case "LOAD_OVER": {
        const r = revIndex.get(f.emails[0]!);
        return r !== undefined && pinnedLoad[r]! > (reviewers[r]!.band?.max ?? 0) ? "pinned reviews exceed the band" : null;
      }
      case "LOAD_UNDER":
        return `band minimum is soft (PCS_SOLVER_LOAD_MIN_BONUS=${settings.loadMinBonus}); counted in the load histogram`;
      case "RECIPROCAL_CYCLE":
        return unresolvedCycles.has([...f.emails].sort().join(" ")) ? "reported as unresolved by the repair pass" : null;
      default:
        return f.pid !== undefined && pinnedPairs.has(`${f.pid}\t${f.emails[0]}`) ? "a pinned assignment (see pin issues)" : null;
    }
  };
  const crossFindings: CrossCheckFinding[] = vr.findings.map((f) => ({ ...f, explainedBy: explain(f) }));
  if (vr.cyclesTruncated) notes.push(`the cross-check listed only the first PCS_CYCLE_MAX_REPORT=${policy.cycleMaxReport} cycles`);

  return {
    mode: hard ? "hard" : "soft",
    feasible,
    objective,
    affinityObjective,
    policy,
    settings: { ...settings, hard },
    sources: {
      tpmsRunId: input.scores?.runs.tpms?.id ?? null,
      localRunId: input.scores?.runs.local?.id ?? null,
      hotcrpPrefs: input.prefs ? table.hotcrpRows : null,
      invitesRunId: input.invites?.runId ?? null,
      doNotInviteRunId: input.doNotInvite?.runId ?? null,
      conflicts: input.conflicts.length,
    },
    counts: {
      papers: pids.length,
      reviewers: reviewers.filter((r) => cap[r.idx]! > 0).length,
      nodes,
      edges,
      candidates,
      pinned: aedges.filter((a) => a.pinned).length,
      assignments: solved.length,
      kept: solved.filter((a) => a.current).length,
      added: solved.filter((a) => !a.current).length,
      cleared: cleared.length,
      solves: solveMs.length,
    },
    unmet,
    load,
    repairs,
    unresolved,
    pinIssues,
    coverage: { threshold: settings.weakAffinity, weak: coverage, unscoredAssignments: solved.filter((a) => a.source === "none").length, scoredPairs: input.scores?.pairs ?? 0 },
    assignments: solved,
    cleared,
    csv,
    lines,
    crossCheck: { findings: crossFindings, unexplained: crossFindings.filter((f) => f.explainedBy === null).length, counts: vr.counts },
    notes,
    timing: { buildMs, solveMs, totalMs: performance.now() - t0 },
  };
}

// ---------------------------------------------------------------------------
// Repair detection

/** What a repair choice may look at. */
interface RepairContext {
  aedges: readonly AEdge[];
  /** aedges indices per paper. */
  byPid: ReadonlyMap<number, readonly number[]>;
  /** Papers each person authors. */
  authored: ReadonlyMap<string, readonly number[]>;
  edgeOf: ReadonlyMap<number, number>;
  pairKey: (pid: number, r: number) => number;
  reviewers: readonly Reviewer[];
}

interface Issue {
  kind: "cycle" | "institution";
  key: string;
  pids: number[];
  emails: string[];
  reason: string;
  /**
   * What to forbid: `removed` are the assignments in the current solution
   * that go, `also` further candidate edges that would recreate the issue.
   * Null if only pinned assignments could break it.
   */
  choose(ctx: RepairContext): { removed: number[]; also: number[] } | null;
}

function detectIssues(
  assigned: readonly AEdge[],
  input: SolverInput,
  reviewers: readonly Reviewer[],
  policy: AssignmentPolicy,
  settings: SolverSettings,
): Issue[] {
  const issues: Issue[] = [];
  const revIdx = new Map(reviewers.map((r) => [r.email, r.idx]));
  // Reciprocal cycles: author of P -> reviewer of P.
  const edges: { from: string; to: string; pid: number }[] = [];
  const byPid = new Map<number, AEdge[]>();
  for (const a of assigned) (byPid.get(a.pid) ?? byPid.set(a.pid, []).get(a.pid)!).push(a);
  for (const [pid, rows] of byPid) {
    for (const au of input.papers.get(pid)!.authors) {
      if (!au.email) continue;
      for (const a of rows) {
        const to = reviewers[a.r]!.email;
        if (to !== au.email) edges.push({ from: au.email, to, pid });
      }
    }
  }
  const cyc = findCycles(edges, policy.cycleMaxK, policy.cycleMaxReport);
  for (const c of cyc.cycles) {
    const k = c.nodes.length;
    const steps = c.nodes.map((a, i) => `${a} authors ${c.pids[i]!.map((p) => `#${p}`).join("/")}, reviewed by ${c.nodes[(i + 1) % k]}`);
    issues.push({
      kind: "cycle",
      key: `cycle:${c.nodes.join(" ")}`,
      pids: [...new Set(c.pids.flat())].sort((a, b) => a - b),
      emails: c.nodes,
      reason: `reciprocal ${k}-cycle (PCS_CYCLE_MAX_K=${policy.cycleMaxK}): ${steps.join("; ")}`,
      // The cycle edge author -> reviewer goes: the reviewer loses the
      // assignments behind it, and every other candidate edge onto a paper by
      // that author, so the same pair can't close a cycle again elsewhere.
      choose(ctx) {
        let best: { removed: number[]; also: number[]; aff: number } | null = null;
        for (let i = 0; i < k; i++) {
          const r = revIdx.get(c.nodes[(i + 1) % k]!)!;
          const removed = c.pids[i]!.map((p) => ctx.edgeOf.get(ctx.pairKey(p, r))!);
          const also: number[] = [];
          let pinned = removed.some((x) => ctx.aedges[x]!.pinned);
          for (const p of ctx.authored.get(c.nodes[i]!) ?? []) {
            const x = ctx.edgeOf.get(ctx.pairKey(p, r));
            if (x === undefined || removed.includes(x)) continue;
            if (ctx.aedges[x]!.pinned) pinned = true;
            else also.push(x);
          }
          if (pinned) continue;
          const aff = removed.reduce((s, x) => s + ctx.aedges[x]!.aff, 0);
          if (!best || aff < best.aff) best = { removed, also, aff };
        }
        return best && { removed: best.removed, also: best.also };
      },
    });
  }
  // One reviewer per institution per paper.
  if (settings.onePerInstitution) {
    for (const [pid, rows] of [...byPid].sort((a, b) => a[0] - b[0])) {
      const groups = new Map<string, AEdge[]>();
      for (const a of rows) {
        const n = reviewers[a.r]!.aff;
        if (n === "") continue;
        (groups.get(n) ?? groups.set(n, []).get(n)!).push(a);
      }
      for (const [inst, g] of groups) {
        if (g.length < 2) continue;
        g.sort((x, y) => Number(!!y.pinned) - Number(!!x.pinned) || y.aff - x.aff || x.r - y.r);
        const emails = g.map((a) => reviewers[a.r]!.email);
        const affiliation = input.people.get(emails[0]!)?.affiliation ?? "";
        const pinnedN = g.filter((a) => a.pinned).length;
        issues.push({
          kind: "institution",
          key: `inst:${pid}:${emails.join(" ")}`,
          pids: [pid],
          emails,
          reason: `#${pid} has ${g.length} reviewers from "${affiliation}" (PCS_SOLVER_ONE_PER_INSTITUTION=true)`,
          // Keep the pinned or best-scoring one; the others go, and so does
          // every other candidate from that institution on this paper.
          choose(ctx) {
            const kept = new Set(g.slice(0, Math.max(1, pinnedN)).map((a) => a.r));
            const removed = g.filter((a) => !kept.has(a.r) && !a.pinned).map((a) => ctx.edgeOf.get(ctx.pairKey(a.pid, a.r))!);
            if (removed.length === 0) return null;
            const also = (ctx.byPid.get(pid) ?? []).filter((x) => {
              const a = ctx.aedges[x]!;
              return !a.pinned && !kept.has(a.r) && !removed.includes(x) && ctx.reviewers[a.r]!.aff === inst;
            });
            return { removed, also };
          },
        });
      }
    }
  }
  return issues;
}
