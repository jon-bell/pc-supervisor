// Random flow instances for the min-cost max-flow tests (PLAN M10a), plus a
// slow, obviously-correct reference solver and a flow checker. Synthetic
// numbers only; node 0 is the source and node 1 the sink, as in
// server/src/modules/solver/mcmf.ts and seed/php/mcmf-driver.php.

import { mulberry32, intBetween, type Rng } from "@pcs/seed/rng";
import { MinCostMaxFlow, type McmfResult } from "../../src/modules/solver/mcmf.js";

/** [src, dst, cap, cost, mincap] */
export type EdgeSpec = [number, number, number, number, number];

export interface Instance {
  n: number;
  edges: EdgeSpec[];
  /** Generator family, for reporting. */
  kind: string;
}

export const SOURCE = 0;
export const SINK = 1;

export function solveInstance(inst: Instance): McmfResult {
  const g = new MinCostMaxFlow();
  g.addNodes(inst.n - 2);
  for (const [s, d, c, k, lb] of inst.edges) g.addEdge(s, d, c, k, lb);
  return g.solve();
}

function costOf(rng: Rng, maxCost: number): number {
  return intBetween(rng, -maxCost, maxCost);
}

/** Lower bound for an edge of capacity `cap`: 0 most of the time. */
function lowerOf(rng: Rng, cap: number, p: number): number {
  return cap > 0 && rng() < p ? intBetween(rng, 1, cap) : 0;
}

/** source -> A -> B -> sink, like an assignment network; lower bounds on A -> B (fed from the source, as HotCRP uses them). */
function layered(rng: Rng, maxCost: number, pLower: number): Instance {
  const a = intBetween(rng, 1, 8);
  const b = intBetween(rng, 1, 8);
  const n = 2 + a + b;
  const edges: EdgeSpec[] = [];
  for (let i = 0; i < a; ++i) edges.push([SOURCE, 2 + i, intBetween(rng, 0, 5), rng() < 0.5 ? 0 : costOf(rng, maxCost), 0]);
  for (let i = 0; i < a; ++i) {
    for (let j = 0; j < b; ++j) {
      if (rng() < 0.5) {
        const cap = intBetween(rng, 1, 3);
        edges.push([2 + i, 2 + a + j, cap, costOf(rng, maxCost), lowerOf(rng, Math.min(cap, 1), pLower)]);
      }
    }
  }
  for (let j = 0; j < b; ++j) edges.push([2 + a + j, SINK, intBetween(rng, 0, 4), rng() < 0.5 ? 0 : costOf(rng, maxCost), 0]);
  return { n, edges, kind: pLower > 0 ? "layered+lb" : "layered" };
}

/** A random digraph (cycles, negative cycles, parallel edges allowed). */
function general(rng: Rng, maxCost: number, pLower: number): Instance {
  const n = intBetween(rng, 3, 16);
  const m = intBetween(rng, n, 4 * n);
  const edges: EdgeSpec[] = [];
  for (let i = 0; i < m; ++i) {
    let s = intBetween(rng, 0, n - 1);
    let d = intBetween(rng, 0, n - 1);
    if (s === SINK) s = SOURCE;
    if (d === SOURCE) d = SINK;
    if (s === d) continue;
    const cap = intBetween(rng, 0, 8);
    edges.push([s, d, cap, costOf(rng, maxCost), lowerOf(rng, cap, pLower)]);
  }
  return { n, edges, kind: pLower > 0 ? "general+lb" : "general" };
}

/**
 * A small spec §10.5 network: reviewers in two tiers feed p.senior / p.third,
 * which feed p, which feeds the sink. `hard` puts lower bounds on the tier
 * edges (true minimums), which leaves deficits at the tier nodes in PHP's
 * starting flow.
 */
function tier(rng: Rng, maxCost: number, hard: boolean): Instance {
  const nr = intBetween(rng, 2, 7);
  const np = intBetween(rng, 1, 5);
  const firstR = 2;
  const firstP = 2 + nr; // per paper: p, p.senior, p.third
  const n = firstP + 3 * np;
  const senior = Array.from({ length: nr }, () => rng() < 0.5);
  const edges: EdgeSpec[] = [];
  for (let r = 0; r < nr; ++r) {
    const load = intBetween(rng, 1, 3);
    for (let i = 0; i < load; ++i) edges.push([SOURCE, firstR + r, 1, 10 * i, 0]); // convex load cost
  }
  for (let p = 0; p < np; ++p) {
    const node = firstP + 3 * p;
    for (let r = 0; r < nr; ++r) {
      if (rng() < 0.7) edges.push([firstR + r, node + (senior[r] ? 1 : 2), 1, -intBetween(rng, 0, maxCost), 0]);
    }
    if (hard) {
      edges.push([node + 1, node, 2, 0, 2]);
      edges.push([node + 2, node, 1, 0, rng() < 0.7 ? 1 : 0]);
    } else {
      edges.push([node + 1, node, 2, -maxCost * 4, 0]);
      edges.push([node + 2, node, 1, -maxCost * 4, 0]);
    }
    edges.push([node, SINK, 3, 0, 0]);
  }
  return { n, edges, kind: hard ? "tier-hard" : "tier-soft" };
}

/** Instance `i` of a reproducible mix of families, cost ranges, and lower-bound densities. */
export function randomInstance(seed: number): Instance {
  const rng = mulberry32(seed);
  const maxCost = [5, 20, 100, 1000, 1_000_000][intBetween(rng, 0, 4)]!;
  const k = intBetween(rng, 0, 6);
  switch (k) {
    case 0:
      return layered(rng, maxCost, 0);
    case 1:
      return layered(rng, maxCost, 0.3);
    case 2:
      return general(rng, maxCost, 0);
    case 3:
    case 4:
      return general(rng, maxCost, 0.15);
    case 5:
      return tier(rng, maxCost, false);
    default:
      return tier(rng, maxCost, true);
  }
}

// ---- checking ----

export interface FlowCheck {
  ok: boolean;
  problems: string[];
  maxFlow: number;
  cost: number;
}

/** Bounds on every edge, conservation everywhere but source and sink; returns the flow value and cost. */
export function checkFlow(inst: Instance, flows: ArrayLike<number>): FlowCheck {
  const problems: string[] = [];
  const net = new Array<number>(inst.n).fill(0);
  let cost = 0;
  inst.edges.forEach(([s, d, cap, c, lb], e) => {
    const f = flows[e]!;
    if (!Number.isInteger(f) || f < lb || f > cap) problems.push(`edge ${e} ${s}->${d}: flow ${f} not in [${lb}, ${cap}]`);
    net[s]! -= f;
    net[d]! += f;
    cost += f * c;
  });
  for (let v = 2; v < inst.n; ++v) if (net[v] !== 0) problems.push(`vertex ${v}: net inflow ${net[v]}`);
  return { ok: problems.length === 0, problems, maxFlow: net[SINK]!, cost };
}

// ---- reference solver: Edmonds-Karp + Bellman-Ford cycle canceling ----

interface Arc {
  to: number;
  rev: number; // index of the paired arc in adj[to]
  cap: number; // residual capacity
  cost: number;
  edge: number; // original edge, or -1
  forward: boolean;
}

class Residual {
  adj: Arc[][];
  constructor(readonly n: number) {
    this.adj = Array.from({ length: n }, () => []);
  }
  add(u: number, v: number, cap: number, cost: number, edge: number, back = 0): void {
    this.adj[u]!.push({ to: v, rev: this.adj[v]!.length, cap, cost, edge, forward: true });
    this.adj[v]!.push({ to: u, rev: this.adj[u]!.length - 1, cap: back, cost: -cost, edge, forward: false });
  }
  /** Augment along shortest (BFS) paths; returns the amount pushed. */
  maxflow(s: number, t: number): number {
    let total = 0;
    for (;;) {
      const prev: ([number, number] | null)[] = new Array<[number, number] | null>(this.n).fill(null);
      const seen = new Array<boolean>(this.n).fill(false);
      seen[s] = true;
      const q = [s];
      while (q.length && !seen[t]) {
        const u = q.shift()!;
        this.adj[u]!.forEach((a, i) => {
          if (a.cap > 0 && !seen[a.to]) {
            seen[a.to] = true;
            prev[a.to] = [u, i];
            q.push(a.to);
          }
        });
      }
      if (!seen[t]) return total;
      let amt = Infinity;
      for (let v = t; v !== s; v = prev[v]![0]) amt = Math.min(amt, this.adj[prev[v]![0]]![prev[v]![1]]!.cap);
      for (let v = t; v !== s; v = prev[v]![0]) this.push(prev[v]![0], prev[v]![1], amt);
      total += amt;
    }
  }
  push(u: number, i: number, amt: number): void {
    const a = this.adj[u]![i]!;
    a.cap -= amt;
    this.adj[a.to]![a.rev]!.cap += amt;
  }
  /** Cancel negative-cost residual cycles until none is left (Klein). */
  cancelNegativeCycles(): void {
    for (;;) {
      const dist = new Array<number>(this.n).fill(0);
      const pred: ([number, number] | null)[] = new Array<[number, number] | null>(this.n).fill(null);
      let last = -1;
      for (let it = 0; it < this.n; ++it) {
        last = -1;
        for (let u = 0; u < this.n; ++u) {
          this.adj[u]!.forEach((a, i) => {
            if (a.cap > 0 && dist[u]! + a.cost < dist[a.to]!) {
              dist[a.to] = dist[u]! + a.cost;
              pred[a.to] = [u, i];
              last = a.to;
            }
          });
        }
        if (last < 0) return;
      }
      let v = last;
      for (let i = 0; i < this.n; ++i) v = pred[v]![0];
      const cycle: [number, number][] = [];
      let x = v;
      do {
        cycle.push(pred[x]!);
        x = pred[x]![0];
      } while (x !== v);
      const amt = Math.min(...cycle.map(([u, i]) => this.adj[u]![i]!.cap));
      for (const [u, i] of cycle) this.push(u, i, amt);
    }
  }
}

export interface ReferenceResult {
  feasible: boolean;
  maxFlow: number;
  cost: number;
  flows: number[];
}

/** Min-cost max-flow with lower bounds, the slow textbook way. Small instances only. */
export function referenceSolve(inst: Instance): ReferenceResult {
  const { n, edges } = inst;
  const m = edges.length;
  // 1. Feasibility: circulation with lower bounds (sink -> source uncapacitated).
  const S = n;
  const T = n + 1;
  const aux = new Residual(n + 2);
  const imb = new Array<number>(n).fill(0);
  edges.forEach(([s, d, cap, , lb], e) => {
    aux.add(s, d, cap - lb, 0, e);
    imb[d]! += lb;
    imb[s]! -= lb;
  });
  aux.add(SINK, SOURCE, 1e9, 0, -1);
  let need = 0;
  for (let v = 0; v < n; ++v) {
    if (imb[v]! > 0) {
      aux.add(S, v, imb[v]!, 0, -1);
      need += imb[v]!;
    } else if (imb[v]! < 0) {
      aux.add(v, T, -imb[v]!, 0, -1);
    }
  }
  if (aux.maxflow(S, T) !== need) return { feasible: false, maxFlow: 0, cost: 0, flows: new Array<number>(m).fill(0) };
  const flows = new Array<number>(m).fill(0);
  for (let u = 0; u < n; ++u) for (const a of aux.adj[u]!) if (a.forward && a.edge >= 0) flows[a.edge] = edges[a.edge]![4] + (edges[a.edge]![2] - edges[a.edge]![4] - a.cap);

  // 2. Max flow from that start; 3. cancel negative cycles (keeps the flow value).
  const r = new Residual(n);
  edges.forEach(([s, d, cap, c, lb], e) => r.add(s, d, cap - flows[e]!, c, e, flows[e]! - lb));
  r.maxflow(SOURCE, SINK);
  r.cancelNegativeCycles();
  for (let u = 0; u < n; ++u) for (const a of r.adj[u]!) if (a.forward) flows[a.edge] = edges[a.edge]![2] - a.cap;
  const chk = checkFlow(inst, flows);
  if (!chk.ok) throw new Error(`reference solver bug: ${chk.problems.join("; ")}`);
  return { feasible: true, maxFlow: chk.maxFlow, cost: chk.cost, flows };
}

// ---- the spec §10.5 shape at conference scale (perf) ----

export interface ScaleOptions {
  seed: number;
  papers: number;
  reviewers: number;
  /** Candidates kept per paper (PCS_SOLVER_TOPK). */
  topK: number;
  /** Tier lower bounds as true minimums (PCS_SOLVER_HARD=1) instead of slot bonuses. */
  hard: boolean;
}

export interface ScaleNetwork {
  g: MinCostMaxFlow;
  nodes: number;
  edges: number;
}

/**
 * source -(band, convex cost)-> reviewer -(cap 1, -affinity)-> p.senior | p.third
 * -> p -(3)-> sink, with 2/3 senior reviewers, top-K candidates per paper,
 * band max 14 (3 reviews x 2,400 papers / 600 reviewers = 12, plus slack).
 */
export function scaleNetwork(o: ScaleOptions): ScaleNetwork {
  const rng = mulberry32(o.seed);
  const g = new MinCostMaxFlow();
  const r0 = g.addNodes(o.reviewers);
  const p0 = g.addNodes(3 * o.papers); // p, p.senior, p.third
  const senior = Array.from({ length: o.reviewers }, (_, i) => i % 3 !== 0);
  const bandMax = 14;
  const loadCost = 20; // per extra unit of load, as paper_assignment_cost * i
  const bonus = 100_000; // PCS_SOLVER_SLOT_BONUS
  for (let r = 0; r < o.reviewers; ++r) for (let i = 0; i < bandMax; ++i) g.addEdge(g.source, r0 + r, 1, loadCost * i);
  const ids = Array.from({ length: o.reviewers }, (_, i) => i);
  for (let p = 0; p < o.papers; ++p) {
    const node = p0 + 3 * p;
    // partial Fisher-Yates: topK distinct candidates
    for (let k = 0; k < o.topK; ++k) {
      const j = k + Math.floor(rng() * (o.reviewers - k));
      [ids[k], ids[j]] = [ids[j]!, ids[k]!];
      const r = ids[k]!;
      g.addEdge(r0 + r, node + (senior[r] ? 1 : 2), 1, -intBetween(rng, 0, 1000));
    }
    if (o.hard) {
      g.addEdge(node + 1, node, 2, 0, 2);
      g.addEdge(node + 2, node, 1, 0, 1);
    } else {
      g.addEdge(node + 1, node, 2, -bonus);
      g.addEdge(node + 2, node, 1, -bonus);
    }
    g.addEdge(node, g.sink, 3, 0);
  }
  return { g, nodes: g.nodeCount, edges: g.edgeCount };
}
