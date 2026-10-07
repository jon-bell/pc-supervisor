// mcmf.ts -- min-cost max-flow with edge lower bounds (spec §10.5, PLAN M10a)
//
// Ported from hotcrp@60f693f88b9a0ef9e34b11af957a513f1c122690 lib/mincostmaxflow.php
// (HotCRP min-cost max-flow). Original copyright and license follow.
//
// Copyright (c) 2006-2025 Eddie Kohler
// Copyright (c) 2006-2008 Regents of the University of California
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the "Software"),
// to deal in the Software without restriction, including without limitation
// the rights to use, copy, modify, merge, publish, distribute, sublicense,
// and/or sell copies of the Software, and to permit persons to whom the
// Software is furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// The names and trademarks of copyright holders may not be used in
// advertising or publicity pertaining to the software without specific
// prior permission. Title to copyright in this software and any associated
// documentation will at all times remain with the copyright holders.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
// FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
// DEALINGS IN THE SOFTWARE.
//
// HotCRP was originally derived from Dirk Grunwald's CRP (Copyright (c)
// 2002-2005 Dirk Grunwald et al., distributed under an "MIT license").
//
// ---------------------------------------------------------------------------
//
// What is ported, and what differs:
//
// - The algorithm is HotCRP's, step for step: relabel-to-front push-relabel
//   for the maximum flow (with the periodic global-relabel BFS), then
//   Goldberg's cost-scaling push-relabel (alpha = 12, push lookahead, the
//   bucket price-update heuristic, arc fixing, and the float-precision stop)
//   to make that flow min-cost. Vertices and edges are visited in the same
//   order as in PHP (each vertex's adjacency lists its outgoing edges, then
//   its incoming ones, in insertion order), so for the same input the flows
//   are normally identical edge for edge, not merely the same cost.
// - Node and edge objects become typed arrays (struct of arrays, CSR
//   adjacency). Node 0 is the source and node 1 the sink, as in PHP, where
//   ".source" and ".sink" are the first two nodes.
// - Lower bounds. PHP starts the max-flow phase from "source edges saturated,
//   every other edge at its lower bound". If that leaves some vertex with a
//   deficit (its lower-bounded outflow exceeds its lower-bounded inflow, e.g.
//   a tier node p.senior -> p with lower bound 2), PHP never routes flow into
//   that vertex: it returns a flow that violates conservation without setting
//   `infeasible`, or loops forever in the relabel-to-front rescan. HotCRP's
//   own autoassigner only puts lower bounds on reviewer -> paper edges whose
//   reviewer is fed from the source, so it never hits this. We add a
//   feasibility phase first (the textbook reduction: an uncapacitated
//   sink -> source arc, a super source feeding lower-bound surpluses and a
//   super sink draining deficits, solved with the same push-relabel code).
//   If it cannot route every lower bound, the instance is infeasible and we
//   report which vertices fall short. If PHP's start would have a deficit, the
//   max-flow phase starts from the feasible flow instead of from zero;
//   otherwise it starts from zero exactly as PHP does.
// - The source's label. Push-relabel needs d(source) = |V| throughout. PHP's
//   global-relabel BFS (pushrelabel_make_distance) labels the source too
//   whenever a source edge has residual capacity, which is always true of the
//   first BFS (it runs before the source edges are saturated). With a small
//   source label, vertices send excess back to the source while an augmenting
//   path still exists, so on general graphs the "maximum" flow can fall short
//   (differential seed 1921: PHP 13, true maximum 14). Two-layer assignment
//   networks like HotCRP's own were never affected in our tests. We keep the
//   source at |V|, and so that excess bound back to the source doesn't climb
//   there one relabel at a time, the global relabel adds the standard second
//   BFS (|V| + distance to the source) and first runs after the source's
//   edges are saturated. `new MinCostMaxFlow({ hotcrpCompat: true })`
//   restores PHP's max-flow phase exactly, for the differential test. The
//   cost-scaling phase is the same in both modes.
// - PHP's `assert($l->distance <= $max_distance)` is a thrown internal error;
//   the progress callbacks, DIMACS I/O, shuffle(), and the debug file are not
//   ported.
//
// Numbers: capacities, lower bounds, and flows are Int32 (0..2^31-1). Costs
// are integers stored in a Float64Array, |cost| <= 2^31-1; solve() also
// requires sum(cap * |cost|) <= 2^53 so the total cost is exact. Excesses
// and prices are Float64 as in PHP (PHP prices are floats). The result is
// exactly optimal unless `precisionLimited` is set: like PHP, the scaling
// stops early (with an epsilon-optimal flow) when epsilon gets within a few
// ULPs of the price magnitudes. With |cost| <= 1e6 and 10^4 vertices that
// cannot happen.
//
// Complexity: push-relabel max flow is O(V^3) worst case (relabel-to-front);
// cost scaling is O(V^2 E log(V C)) worst case, with log_12(V C) refine
// phases. In practice, on the 2,400-paper x 600-reviewer network (7.8k
// vertices, 160k edges) a solve takes 1-2 s on a 4-core machine
// (test/unit/solver/mcmf-perf.test.ts).

const ALPHA = 12; // MinCostMaxFlow::CSPUSHRELABEL_ALPHA
const NIL = -1; // PHP null in link/xlink
const OFF = -2; // PHP false in link ("not on the active list")
const MAX_CAP = 0x7fffffff;
const MAX_COST = 0x7fffffff;

/** A vertex that could not get (or get rid of) the flow its edges' lower bounds force through it. */
export interface UnmetLowerBound {
  node: number;
  /** "inflow": lower-bounded edges leave it, but not enough flow can reach it. "outflow": the reverse. */
  need: "inflow" | "outflow";
  /** Units that could not be routed. */
  amount: number;
}

export interface McmfResult {
  /** False if no flow satisfies every edge's lower bound. Then flows are all 0 and maxFlow/cost are 0. */
  feasible: boolean;
  /** Net flow into the sink: the maximum over flows that meet every lower bound. */
  maxFlow: number;
  /** sum(flow * cost): the minimum among maximum flows (unless precisionLimited). */
  cost: number;
  /** Flow per edge, indexed by addEdge's return value. A copy; safe to keep. */
  flows: Int32Array;
  /** Scaling stopped early for float precision; cost is epsilon-optimal, not exact. Never set for |cost| <= 1e6. */
  precisionLimited: boolean;
  /** Why it is infeasible (empty when feasible). */
  unmet: UnmetLowerBound[];
  stats: {
    /** The max-flow phase started from the feasibility flow (PHP's start would have had a deficit). */
    feasibilityStart: boolean;
    refinePhases: number;
    pushes: number;
    relabels: number;
  };
}

/** Growable Int32/Float64 storage for edges while the network is built. */
class Grow<T extends Int32Array | Float64Array> {
  n = 0;
  constructor(
    public a: T,
    private readonly make: (len: number) => T,
  ) {}
  push(x: number): void {
    if (this.n === this.a.length) {
      const b = this.make(Math.max(16, this.a.length * 2));
      b.set(this.a);
      this.a = b;
    }
    this.a[this.n++] = x;
  }
}

const i32 = (len: number): Int32Array => new Int32Array(len);
const f64 = (len: number): Float64Array => new Float64Array(len);

/**
 * The flow network plus solver state, in PHP's terms: nodes have
 * distance/excess/price/npos/n_outgoing_admissible/link/xlink; edges have
 * src/dst/cap/mincap/cost/flow. `adj` is CSR: vertex v's edges are
 * adj[start[v] .. start[v] + deg[v]), and arc fixing shrinks deg[v].
 */
class Net {
  readonly src: Int32Array;
  readonly dst: Int32Array;
  readonly cap: Int32Array;
  readonly mincap: Int32Array;
  readonly cost: Float64Array;
  readonly flow: Int32Array;
  readonly start: Int32Array;
  readonly deg: Int32Array;
  readonly adj: Int32Array;
  readonly distance: Float64Array;
  readonly excess: Float64Array;
  readonly price: Float64Array;
  readonly npos: Int32Array;
  readonly nadm: Int32Array;
  readonly link: Int32Array;
  readonly xlink: Int32Array;
  readonly queue: Int32Array;
  mincost = 0;
  maxcost = 0;
  epsilon = 0;
  ltail = NIL;
  npush = 0;
  nrelabel = 0;
  phases = 0;
  precisionLimited = false;
  /** Reproduce PHP's source relabeling in the max-flow BFS (differential test only). */
  hotcrpCompat = false;

  constructor(
    readonly n: number,
    readonly m: number,
    src: Int32Array,
    dst: Int32Array,
    cap: Int32Array,
    mincap: Int32Array,
    cost: Float64Array,
  ) {
    this.src = src;
    this.dst = dst;
    this.cap = cap;
    this.mincap = mincap;
    this.cost = cost;
    this.flow = new Int32Array(m);
    this.start = new Int32Array(n + 1);
    this.deg = new Int32Array(n);
    this.adj = new Int32Array(2 * m);
    this.distance = new Float64Array(n);
    this.excess = new Float64Array(n);
    this.price = new Float64Array(n);
    this.npos = new Int32Array(n);
    this.nadm = new Int32Array(n);
    this.link = new Int32Array(n).fill(NIL);
    this.xlink = new Int32Array(n).fill(NIL);
    this.queue = new Int32Array(n);
    for (let e = 0; e < m; ++e) {
      this.mincost = Math.min(this.mincost, cost[e]!);
      this.maxcost = Math.max(this.maxcost, cost[e]!);
    }
  }

  /** initialize_edges(): every vertex lists the edges it is the source of, then those it is the destination of. */
  initializeEdges(): void {
    const { n, m, src, dst, start, deg, adj } = this;
    deg.fill(0);
    for (let e = 0; e < m; ++e) {
      ++deg[src[e]!]!;
      ++deg[dst[e]!]!;
    }
    start[0] = 0;
    for (let v = 0; v < n; ++v) start[v + 1] = start[v]! + deg[v]!;
    const pos = start.slice(0, n);
    for (let e = 0; e < m; ++e) adj[pos[src[e]!]!++] = e;
    for (let e = 0; e < m; ++e) adj[pos[dst[e]!]!++] = e;
  }

  updateFlow(e: number, delta: number): void {
    this.flow[e]! += delta;
    this.excess[this.src[e]!]! -= delta;
    this.excess[this.dst[e]!]! += delta;
  }

  /** residual_cap_from(v) */
  private rcapFrom(e: number, v: number): number {
    return v === this.src[e] ? this.cap[e]! - this.flow[e]! : this.flow[e]! - this.mincap[e]!;
  }

  /** is_price_admissible_from(v) */
  private priceAdmissibleFrom(e: number, v: number): boolean {
    const s = this.src[e]!;
    const c = this.cost[e]! + this.price[s]! - this.price[this.dst[e]!]!;
    if (v === s) return this.flow[e]! < this.cap[e]! && c < 0;
    return this.flow[e]! > this.mincap[e]! && c > 0;
  }

  /** reduced_cost(isrev) */
  private reducedCost(e: number, isrev: boolean): number {
    const c = this.cost[e]! + this.price[this.src[e]!]! - this.price[this.dst[e]!]!;
    return isrev ? -c : c;
  }

  // ---- push-relabel: maximum flow only, ignores costs ----

  /** pushrelabel_make_distance(): BFS from the sink over residual arcs; unreached vertices keep their distance. */
  private makeDistance(source: number, sink: number): void {
    const { src, dst, cap, mincap, flow, start, deg, adj, distance, npos, xlink } = this;
    xlink.fill(sink); // "unvisited" (PHP: xlink === sink)
    // Fix: the source keeps label n (PHP lets the BFS relabel it; see the file comment).
    if (!this.hotcrpCompat) xlink[source] = NIL;
    let qhead = sink;
    let qtail = sink;
    distance[sink] = 0;
    xlink[sink] = NIL;
    while (qhead !== NIL) {
      const d = distance[qhead]! + 1;
      const end = start[qhead]! + deg[qhead]!;
      for (let i = start[qhead]!; i < end; ++i) {
        const e = adj[i]!;
        const isSrc = qhead === src[e];
        const rc = isSrc ? flow[e]! - mincap[e]! : cap[e]! - flow[e]!; // residual_cap_to(qhead)
        const o = isSrc ? dst[e]! : src[e]!;
        if (rc > 0 && xlink[o] === sink) {
          if (distance[o] !== d) {
            distance[o] = d;
            npos[o] = 0;
          }
          xlink[o] = NIL;
          xlink[qtail] = o;
          qtail = o;
        }
      }
      qhead = xlink[qhead]!;
    }
    if (!this.hotcrpCompat) this.labelFromSource(source, sink);
  }

  /**
   * Not in PHP: the second half of the standard global relabel. Vertices the
   * sink BFS missed get |V| + their residual distance to the source, so
   * excess that must return to the source goes straight back instead of
   * climbing one relabel at a time (with the source pinned at |V| that climb
   * dominated the run time). Vertices that reach neither get 2|V| - 1.
   */
  private labelFromSource(source: number, sink: number): void {
    const { n, src, dst, cap, mincap, flow, start, deg, adj, distance, npos, xlink, queue } = this;
    let qh = 0;
    let qt = 0;
    distance[source] = n;
    queue[qt++] = source;
    while (qh < qt) {
      const u = queue[qh++]!;
      const d = distance[u]! + 1;
      const end = start[u]! + deg[u]!;
      for (let i = start[u]!; i < end; ++i) {
        const e = adj[i]!;
        const isSrc = u === src[e];
        const rc = isSrc ? flow[e]! - mincap[e]! : cap[e]! - flow[e]!; // residual arc o -> u
        const o = isSrc ? dst[e]! : src[e]!;
        if (rc > 0 && xlink[o] === sink) {
          if (distance[o] !== d) {
            distance[o] = d;
            npos[o] = 0;
          }
          xlink[o] = NIL;
          queue[qt++] = o;
        }
      }
    }
    for (let v = 0; v < n; ++v) {
      if (xlink[v] === sink && v !== source && distance[v] !== 2 * n - 1) {
        distance[v] = 2 * n - 1;
        npos[v] = 0;
      }
    }
  }

  private relabelMaxflow(v: number): void {
    const { src, dst, start, deg, adj, distance } = this;
    let d = Infinity;
    const end = start[v]! + deg[v]!;
    for (let i = start[v]!; i < end; ++i) {
      const e = adj[i]!;
      if (this.rcapFrom(e, v) > 0) {
        const o = v === src[e] ? dst[e]! : src[e]!;
        d = Math.min(d, distance[o]! + 1);
      }
    }
    distance[v] = d;
    this.npos[v] = 0;
  }

  private dischargeMaxflow(v: number): boolean {
    const { src, dst, cap, mincap, flow, start, adj, distance, excess, npos } = this;
    const ne = this.deg[v]!;
    let relabeled = false;
    while (excess[v]! > 0 && distance[v]! < Infinity) {
      if (npos[v] === ne) {
        this.relabelMaxflow(v);
        relabeled = true;
      } else {
        const e = adj[start[v]! + npos[v]!]!;
        // is_distance_admissible_from(v)
        const admissible =
          v === src[e]
            ? flow[e]! < cap[e]! && distance[v] === distance[dst[e]!]! + 1
            : flow[e]! > mincap[e]! && distance[v] === distance[src[e]!]! + 1;
        if (admissible) {
          // pushrelabel_push_from
          const amt = Math.min(excess[v]!, this.rcapFrom(e, v));
          this.updateFlow(e, v === dst[e] ? -amt : amt);
        } else {
          ++npos[v]!;
        }
      }
    }
    return relabeled;
  }

  /**
   * pushrelabel_run(): saturate the source's edges, raise every other edge to
   * its lower bound, then relabel-to-front. Starts from the current flow
   * (zero, as in PHP, unless the feasibility phase supplied one). Returns the
   * max-flow value, or null if some vertex's excess has nowhere to go.
   */
  pushRelabel(source: number, sink: number): number | null {
    const { n, m, src, cap, mincap, flow, distance, npos, excess, link } = this;
    for (let v = 0; v < n; ++v) {
      distance[v] = n;
      npos[v] = 0;
    }
    // PHP labels before saturating the source's edges; we label after (the
    // labels then describe the residual graph the discharge loop starts on).
    if (this.hotcrpCompat) this.makeDistance(source, sink);
    for (let e = 0; e < m; ++e) {
      if (src[e] === source) this.updateFlow(e, cap[e]! - flow[e]!);
      else if (flow[e]! < mincap[e]!) this.updateFlow(e, mincap[e]! - flow[e]!);
    }
    if (!this.hotcrpCompat) this.makeDistance(source, sink);

    let lhead = NIL;
    let ltail = NIL;
    for (let v = 0; v < n; ++v) {
      if (v !== source && v !== sink) {
        if (ltail !== NIL) link[ltail] = v;
        else lhead = v;
        link[v] = NIL;
        ltail = v;
      }
    }

    let l = lhead;
    let lprev = NIL;
    const maxDistance = 2 * n - 1;
    let nrelabel = 0;
    let feasible = true;
    while (l !== NIL) {
      if (this.dischargeMaxflow(l)) {
        if (distance[l]! >= Infinity) {
          feasible = false;
          break;
        }
        ++nrelabel;
        if (nrelabel % n === 0) this.makeDistance(source, sink);
        if (l !== lhead) {
          link[lprev] = link[l]!;
          link[l] = lhead;
          lhead = l;
        }
      }
      if (distance[l]! > maxDistance) {
        throw new Error(`mcmf: internal error: vertex ${l} distance ${distance[l]} > ${maxDistance}`);
      }
      lprev = l;
      l = link[l]!;
      if (l === NIL) {
        lprev = NIL;
        for (l = lhead; l !== NIL && excess[l] === 0; ) {
          lprev = l;
          l = link[l]!;
        }
      }
    }
    this.nrelabel += nrelabel;
    const maxflow = excess[sink]!;
    excess[source] = excess[sink] = 0;
    return feasible ? maxflow : null;
  }

  // ---- cost-scaling push-relabel ----

  /** count_outgoing_price_admissible() */
  private countOutgoingAdmissible(v: number): number {
    let k = 0;
    const end = this.start[v]! + this.deg[v]!;
    for (let i = this.start[v]!; i < end; ++i) if (this.priceAdmissibleFrom(this.adj[i]!, v)) ++k;
    return k;
  }

  /** set_price_fix_admissible(): change v's price and keep every n_outgoing_admissible count right. */
  private setPrice(v: number, p: number): void {
    const { src, dst, cap, mincap, cost, flow, start, deg, adj, price, nadm } = this;
    const oldPrice = price[v]!;
    price[v] = p;
    const end = start[v]! + deg[v]!;
    for (let i = start[v]!; i < end; ++i) {
      const e = adj[i]!;
      const s = src[e]!;
      const d = dst[e]!;
      const rc = cost[e]! + price[s]! - price[d]!;
      const oldRc = s === v ? cost[e]! + oldPrice - price[d]! : cost[e]! + price[s]! - oldPrice;
      if (rc < 0 !== oldRc < 0 && flow[e]! < cap[e]!) nadm[s]! += rc < 0 ? 1 : -1;
      if (rc > 0 !== oldRc > 0 && flow[e]! > mincap[e]!) nadm[d]! += rc > 0 ? 1 : -1;
    }
  }

  private pushCs(e: number, v: number): void {
    const { src, dst, excess, link } = this;
    const d = v === src[e] ? dst[e]! : src[e]!;
    // push lookahead heuristic
    if (excess[d]! >= 0 && this.nadm[d] === 0) {
      this.relabelCs(d);
      return;
    }
    const amt = Math.min(excess[v]!, this.rcapFrom(e, v));
    this.updateFlow(e, src[e] === v ? amt : -amt);
    if (this.rcapFrom(e, v) === 0) --this.nadm[v]!;
    if (excess[d]! > 0 && link[d] === OFF) {
      link[this.ltail] = d;
      this.ltail = d;
      link[d] = NIL;
    }
    ++this.npush;
  }

  private relabelCs(v: number): void {
    const { src, dst, cap, mincap, cost, flow, start, deg, adj, price } = this;
    let p = -Infinity;
    let ex = 0;
    const s0 = start[v]!;
    const end = s0 + deg[v]!;
    for (let i = s0; i < end; ++i) {
      const e = adj[i]!;
      let px: number;
      if (src[e] === v && flow[e]! < cap[e]!) px = price[dst[e]!]! - cost[e]!;
      else if (dst[e] === v && flow[e]! > mincap[e]!) px = price[src[e]!]! + cost[e]!;
      else continue;
      if (px > p) {
        p = px;
        ex = i - s0;
      }
    }
    if (p > -Infinity) this.npos[v] = ex;
    else p = price[v]!;
    p -= this.epsilon;
    this.setPrice(v, p);
    ++this.nrelabel;
  }

  private dischargeCs(v: number): void {
    const ne = this.deg[v]!;
    const { excess, npos, nadm, adj, start } = this;
    while (excess[v]! > 0) {
      if (npos[v] === ne || nadm[v] === 0) {
        this.relabelCs(v);
      } else {
        const e = adj[start[v]! + npos[v]!]!;
        if (this.priceAdmissibleFrom(e, v)) this.pushCs(e, v);
        else ++npos[v]!;
      }
    }
  }

  /** cspushrelabel_reprice(): the bucket-based price update heuristic. */
  private reprice(): void {
    const { n, src, dst, cap, mincap, flow, start, deg, adj, distance, excess, price } = this;
    const maxDistance = Math.trunc(2 * (n + 1) * ALPHA + 2);
    let ex = 0;
    const b: number[][] = [[]];
    for (let v = 0; v < n; ++v) {
      if (excess[v]! < 0) {
        distance[v] = 0;
        b[0]!.push(v);
      } else {
        distance[v] = maxDistance;
      }
      ex += Math.max(excess[v]!, 0);
    }
    const totalExcess = ex;

    let bi = 0;
    while (bi < b.length && ex > 0) {
      const bucket = b[bi]!;
      if (bucket.length === 0) {
        ++bi;
        continue;
      }
      const v = bucket.pop()!;
      if (distance[v] !== bi) continue;
      const end = start[v]! + deg[v]!;
      for (let i = start[v]!; i < end; ++i) {
        const e = adj[i]!;
        const isSrc = v === src[e];
        const rcTo = isSrc ? flow[e]! - mincap[e]! : cap[e]! - flow[e]!; // residual_cap_to(v)
        const d = isSrc ? dst[e]! : src[e]!;
        if (rcTo !== 0 && bi < distance[d]!) {
          let nd = bi;
          const c = this.reducedCost(e, d === dst[e]); // reduced_cost_from(d)
          if (c >= 0) nd += 1 + Math.trunc(Math.min(maxDistance, c / this.epsilon));
          if (nd < distance[d]!) {
            distance[d] = nd;
            while (b.length <= nd) b.push([]);
            b[nd]!.push(d);
          }
        }
      }
      if (bi) this.setPrice(v, price[v]! - bi * this.epsilon);
      distance[v] = -1;
      ex -= Math.max(excess[v]!, 0);
    }

    if (totalExcess && bi) {
      for (let v = 0; v < n; ++v) {
        if (distance[v]! >= 0) this.setPrice(v, price[v]! - bi * this.epsilon);
      }
    }
  }

  /** cspushrelabel_refine() */
  private refine(): void {
    const { n, src, cap, mincap, flow, start, deg, adj, excess, npos, nadm, link } = this;

    // arc fixing (see the PHP comment: absolute value of REDUCED costs,
    // Goldberg & Tarjan 1990's bound)
    const fixbound = n * this.epsilon * (1 + 1.0 / ALPHA);
    if (Math.max(Math.abs(this.mincost), this.maxcost) >= fixbound) {
      for (let v = 0; v < n; ++v) {
        const s0 = start[v]!;
        for (let i = 0; i < deg[v]!; ) {
          const e = adj[s0 + i]!;
          if (Math.abs(this.reducedCost(e, false)) >= fixbound) {
            if (this.priceAdmissibleFrom(e, v)) --nadm[v]!;
            adj[s0 + i] = adj[s0 + deg[v]! - 1]!;
            --deg[v]!;
            npos[v] = 0;
          } else {
            ++i;
          }
        }
      }
    }

    this.epsilon = this.epsilon / ALPHA;

    // saturate negative-cost arcs
    for (let v = 0; v < n; ++v) {
      if (nadm[v] !== 0) {
        const end = start[v]! + deg[v]!;
        for (let i = start[v]!; i < end; ++i) {
          const e = adj[i]!;
          if (this.priceAdmissibleFrom(e, v)) {
            const delta = (src[e] === v ? cap[e]! : mincap[e]!) - flow[e]!;
            this.updateFlow(e, delta);
            --nadm[v]!;
          }
        }
      }
    }

    // initialize lists and neighbor position
    let lhead = NIL;
    this.ltail = NIL;
    for (let v = 0; v < n; ++v) {
      npos[v] = 0;
      if (excess[v]! > 0) {
        if (this.ltail !== NIL) link[this.ltail] = v;
        else lhead = v;
        link[v] = NIL;
        this.ltail = v;
      } else {
        link[v] = OFF;
      }
    }

    this.reprice();

    while (lhead !== NIL) {
      this.dischargeCs(lhead);
      const l = link[lhead]!;
      link[lhead] = OFF;
      lhead = l;
    }
    ++this.phases;
  }

  /** cspushrelabel_precise() */
  private precise(epsilon: number): boolean {
    const m = Math.max(Math.abs(this.mincost), this.maxcost) + 3 * this.n * this.epsilon;
    let pmax = 0;
    for (let v = 0; v < this.n; ++v) pmax = Math.max(pmax, Math.abs(this.price[v]!));
    return epsilon >= 8 * Number.EPSILON * (m + pmax);
  }

  /** cspushrelabel_finish(): refine the maximum flow to min cost. */
  costScaling(): void {
    this.epsilon = Math.max(Math.abs(this.mincost), this.maxcost);
    for (let v = 0; v < this.n; ++v) this.nadm[v] = this.countOutgoingAdmissible(v);
    while (this.epsilon >= 1 / this.n) {
      if (!this.precise(this.epsilon / ALPHA)) {
        this.precisionLimited = true;
        break;
      }
      this.refine();
    }
  }
}

function checkInt(what: string, x: number, lo: number, hi: number): void {
  if (!Number.isInteger(x) || x < lo || x > hi) throw new RangeError(`mcmf: ${what} ${x} is not an integer in [${lo}, ${hi}]`);
}

/**
 * Min-cost max-flow with edge lower bounds (a port of HotCRP's
 * MinCostMaxFlow). Build with addNode/addEdge, then solve(). The network may
 * be changed with setCapacity/forbid and solved again; every solve starts
 * from scratch (deterministic: same network, same flows), see solve().
 *
 *   const g = new MinCostMaxFlow();
 *   const r = g.addNode(), p = g.addNode();
 *   g.addEdge(g.source, r, 3, 0);
 *   const e = g.addEdge(r, p, 1, -80, 1);   // cap 1, cost -80, lower bound 1
 *   g.addEdge(p, g.sink, 2, 0);
 *   const res = g.solve();                   // res.flows[e] === 1
 */
export interface McmfOptions {
  /**
   * Reproduce HotCRP's max-flow phase exactly, including the source-relabel
   * defect (see the file comment): the max flow may then fall short on
   * general graphs. For the differential test only.
   */
  hotcrpCompat?: boolean;
}

export class MinCostMaxFlow {
  private readonly hotcrpCompat: boolean;
  constructor(opts: McmfOptions = {}) {
    this.hotcrpCompat = opts.hotcrpCompat ?? false;
  }

  /** Node 0 (PHP ".source"). It may have no incoming edges. */
  readonly source = 0;
  /** Node 1 (PHP ".sink"). It may have no outgoing edges. */
  readonly sink = 1;
  private nNodes = 2;
  private readonly eSrc = new Grow(i32(0), i32);
  private readonly eDst = new Grow(i32(0), i32);
  private readonly eCap = new Grow(i32(0), i32);
  private readonly eMin = new Grow(i32(0), i32);
  private readonly eCost = new Grow(f64(0), f64);

  get nodeCount(): number {
    return this.nNodes;
  }

  get edgeCount(): number {
    return this.eSrc.n;
  }

  /** Add a vertex; returns its index (2, 3, ...). */
  addNode(): number {
    return this.nNodes++;
  }

  /** Add `k` vertices; returns the first index (they are consecutive). */
  addNodes(k: number): number {
    checkInt("node count", k, 0, MAX_CAP);
    const first = this.nNodes;
    this.nNodes += k;
    return first;
  }

  /**
   * Add an edge src -> dst carrying between `minCap` and `cap` units at
   * `cost` per unit. Returns the edge index. Parallel edges are allowed (use
   * them for convex costs: k unit edges with rising costs).
   */
  addEdge(src: number, dst: number, cap: number, cost = 0, minCap = 0): number {
    checkInt("edge source", src, 0, this.nNodes - 1);
    checkInt("edge destination", dst, 0, this.nNodes - 1);
    if (src === dst) throw new RangeError(`mcmf: self-loop at ${src}`);
    if (src === this.sink || dst === this.source) throw new RangeError("mcmf: no edges out of the sink or into the source");
    checkInt("capacity", cap, 0, MAX_CAP);
    checkInt("lower bound", minCap, 0, cap);
    checkInt("cost", cost, -MAX_COST, MAX_COST);
    this.eSrc.push(src);
    this.eDst.push(dst);
    this.eCap.push(cap);
    this.eMin.push(minCap);
    this.eCost.push(cost);
    return this.eSrc.n - 1;
  }

  /** Change an edge's capacity and lower bound (for the next solve). */
  setCapacity(e: number, cap: number, minCap = 0): void {
    checkInt("edge", e, 0, this.edgeCount - 1);
    checkInt("capacity", cap, 0, MAX_CAP);
    checkInt("lower bound", minCap, 0, cap);
    this.eCap.a[e] = cap;
    this.eMin.a[e] = minCap;
  }

  /** Remove an edge from the next solve (capacity and lower bound 0). Undo with setCapacity. */
  forbid(e: number): void {
    this.setCapacity(e, 0, 0);
  }

  edge(e: number): { src: number; dst: number; cap: number; minCap: number; cost: number } {
    checkInt("edge", e, 0, this.edgeCount - 1);
    return { src: this.eSrc.a[e]!, dst: this.eDst.a[e]!, cap: this.eCap.a[e]!, minCap: this.eMin.a[e]!, cost: this.eCost.a[e]! };
  }

  /**
   * Solve from scratch: the maximum source -> sink flow that respects every
   * edge's [minCap, cap], and among those, one of minimum total cost.
   * Infeasible lower bounds are reported (feasible: false, unmet), not thrown.
   *
   * Re-solving after forbid()/setCapacity() is a full solve on the current
   * network (no warm start); it costs the same as the first solve.
   */
  solve(): McmfResult {
    const n = this.nNodes;
    const m = this.edgeCount;
    const src = this.eSrc.a.slice(0, m);
    const dst = this.eDst.a.slice(0, m);
    const cap = this.eCap.a.slice(0, m);
    const mincap = this.eMin.a.slice(0, m);
    const cost = this.eCost.a.slice(0, m);

    let costBound = 0;
    let anyLower = false;
    for (let e = 0; e < m; ++e) {
      costBound += cap[e]! * Math.abs(cost[e]!);
      if (mincap[e]! > 0) anyLower = true;
    }
    if (costBound > Number.MAX_SAFE_INTEGER) {
      throw new RangeError(`mcmf: sum(cap * |cost|) = ${costBound} exceeds 2^53; total cost would not be exact`);
    }

    const net = new Net(n, m, src, dst, cap, mincap, cost);
    let feasibilityStart = false;

    if (anyLower) {
      const feas = feasibleFlow(net, this.source, this.sink);
      if (!feas.ok) return infeasibleResult(m, feas.unmet);
      // Would PHP's start (source edges full, the rest at their lower bound)
      // leave a vertex in deficit? Then start from the feasible flow.
      const init = new Float64Array(n);
      for (let e = 0; e < m; ++e) {
        const f = src[e] === this.source ? cap[e]! : mincap[e]!;
        init[src[e]!]! -= f;
        init[dst[e]!]! += f;
      }
      for (let v = 2; v < n; ++v) {
        if (init[v]! < 0) {
          feasibilityStart = true;
          break;
        }
      }
      if (feasibilityStart) {
        net.flow.set(feas.flow);
        for (let e = 0; e < m; ++e) {
          net.excess[src[e]!]! -= feas.flow[e]!;
          net.excess[dst[e]!]! += feas.flow[e]!;
        }
      }
    }

    net.hotcrpCompat = this.hotcrpCompat;
    net.initializeEdges();
    const maxFlow = net.pushRelabel(this.source, this.sink);
    if (maxFlow === null && this.hotcrpCompat) return infeasibleResult(m, []);
    if (maxFlow === null) {
      // The feasibility phase routed every lower bound, so push-relabel
      // must find somewhere for every excess.
      throw new Error("mcmf: internal error: max-flow phase stuck on a feasible network");
    }
    if (net.mincost !== 0 || net.maxcost !== 0) net.costScaling();

    let total = 0;
    for (let e = 0; e < m; ++e) if (net.flow[e]) total += net.flow[e]! * cost[e]!;
    return {
      feasible: true,
      maxFlow,
      cost: total,
      flows: net.flow,
      precisionLimited: net.precisionLimited,
      unmet: [],
      stats: { feasibilityStart, refinePhases: net.phases, pushes: net.npush, relabels: net.nrelabel },
    };
  }
}

function infeasibleResult(m: number, unmet: UnmetLowerBound[]): McmfResult {
  return {
    feasible: false,
    maxFlow: 0,
    cost: 0,
    flows: new Int32Array(m),
    precisionLimited: false,
    unmet,
    stats: { feasibilityStart: false, refinePhases: 0, pushes: 0, relabels: 0 },
  };
}

/**
 * Feasibility phase (not in PHP): find any flow meeting every lower bound,
 * by the textbook reduction. Edge e keeps its index with range
 * [0, cap - mincap]; edge m is sink -> source (uncapacitated); a super source
 * S feeds each vertex its lower-bound surplus and each vertex drains its
 * lower-bound deficit to a super sink T. Feasible iff the S -> T max flow
 * saturates S's edges. Solved with the same push-relabel code.
 */
function feasibleFlow(
  net: Net,
  source: number,
  sink: number,
): { ok: true; flow: Int32Array } | { ok: false; unmet: UnmetLowerBound[] } {
  const { n, m, src, dst, cap, mincap } = net;
  const imb = new Float64Array(n);
  let sourceCap = 0;
  for (let e = 0; e < m; ++e) {
    imb[dst[e]!]! += mincap[e]!;
    imb[src[e]!]! -= mincap[e]!;
    if (src[e] === source) sourceCap += cap[e]!;
  }
  const S = n;
  const T = n + 1;
  const xs: number[] = [];
  const xd: number[] = [];
  const xc: number[] = [];
  for (let v = 0; v < n; ++v) {
    if (imb[v]! > 0) {
      xs.push(S);
      xd.push(v);
      xc.push(imb[v]!);
    } else if (imb[v]! < 0) {
      xs.push(v);
      xd.push(T);
      xc.push(-imb[v]!);
    }
  }
  const m2 = m + 1 + xs.length;
  const s2 = new Int32Array(m2);
  const d2 = new Int32Array(m2);
  const c2 = new Int32Array(m2);
  s2.set(src);
  d2.set(dst);
  for (let e = 0; e < m; ++e) c2[e] = cap[e]! - mincap[e]!;
  s2[m] = sink;
  d2[m] = source;
  c2[m] = Math.min(MAX_CAP, sourceCap);
  for (let i = 0; i < xs.length; ++i) {
    s2[m + 1 + i] = xs[i]!;
    d2[m + 1 + i] = xd[i]!;
    checkInt("lower-bound imbalance", xc[i]!, 0, MAX_CAP);
    c2[m + 1 + i] = xc[i]!;
  }
  const aux = new Net(n + 2, m2, s2, d2, c2, new Int32Array(m2), new Float64Array(m2));
  aux.initializeEdges();
  aux.pushRelabel(S, T);

  const unmet: UnmetLowerBound[] = [];
  for (let i = 0; i < xs.length; ++i) {
    const e = m + 1 + i;
    const short = c2[e]! - aux.flow[e]!;
    if (short > 0) {
      unmet.push(xs[i] === S ? { node: xd[i]!, need: "outflow", amount: short } : { node: xs[i]!, need: "inflow", amount: short });
    }
  }
  if (unmet.length) return { ok: false, unmet };
  const flow = new Int32Array(m);
  for (let e = 0; e < m; ++e) flow[e] = mincap[e]! + aux.flow[e]!;
  return { ok: true, flow };
}
