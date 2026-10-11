// MinCostMaxFlow (PLAN M10a): properties against a slow reference solver
// (Edmonds-Karp + Bellman-Ford cycle canceling), plus the API contract.
// The differential test against HotCRP's PHP is in
// test/integration/mcmf-differential.test.ts.

import { describe, expect, it } from "vitest";
import { MinCostMaxFlow } from "../../../src/modules/solver/mcmf.js";
import { checkFlow, randomInstance, referenceSolve, solveInstance, type Instance } from "../../support/mcmf-instances.js";

function build(inst: Instance, opts = {}): MinCostMaxFlow {
  const g = new MinCostMaxFlow(opts);
  g.addNodes(inst.n - 2);
  for (const [s, d, c, k, lb] of inst.edges) g.addEdge(s, d, c, k, lb);
  return g;
}

describe("MinCostMaxFlow vs the reference solver", () => {
  it("is feasible exactly when the reference is, with the same max flow and min cost (600 random instances)", () => {
    const kinds = new Map<string, { n: number; feasible: number }>();
    for (let seed = 1; seed <= 600; ++seed) {
      const inst = randomInstance(seed);
      const ref = referenceSolve(inst);
      const res = solveInstance(inst);
      const where = `seed ${seed} (${inst.kind})`;
      const k = kinds.get(inst.kind) ?? { n: 0, feasible: 0 };
      k.n++;
      expect(res.feasible, where).toBe(ref.feasible);
      if (res.feasible) {
        k.feasible++;
        const chk = checkFlow(inst, res.flows);
        expect(chk.problems, where).toEqual([]);
        expect(res.maxFlow, where).toBe(ref.maxFlow);
        expect(chk.maxFlow, where).toBe(res.maxFlow);
        expect(res.cost, where).toBe(ref.cost);
        expect(chk.cost, where).toBe(res.cost);
        expect(res.unmet, where).toEqual([]);
      } else {
        expect(res.unmet.length, where).toBeGreaterThan(0);
        expect(Array.from(res.flows).every((f) => f === 0), where).toBe(true);
      }
      kinds.set(inst.kind, k);
    }
    // The mix really has lower bounds, feasible and infeasible.
    const lb = [...kinds].filter(([kind]) => kind.includes("lb") || kind === "tier-hard");
    expect(lb.some(([, k]) => k.feasible > 0)).toBe(true);
    expect(lb.some(([, k]) => k.feasible < k.n)).toBe(true);
  });

  it("re-solves correctly after forbid() and setCapacity()", () => {
    for (let seed = 1; seed <= 150; ++seed) {
      const inst = randomInstance(seed);
      if (inst.edges.length === 0) continue;
      const g = build(inst);
      const first = g.solve();
      const e = seed % inst.edges.length;
      g.forbid(e);
      const without: Instance = { ...inst, edges: inst.edges.map((x, i) => (i === e ? [x[0], x[1], 0, x[3], 0] : x)) };
      const ref = referenceSolve(without);
      const second = g.solve();
      expect(second.feasible, `seed ${seed}`).toBe(ref.feasible);
      if (ref.feasible) {
        expect(second.flows[e]).toBe(0);
        expect(second.cost, `seed ${seed}`).toBe(ref.cost);
        expect(second.maxFlow, `seed ${seed}`).toBe(ref.maxFlow);
      }
      const [, , cap, , lb] = inst.edges[e]!;
      g.setCapacity(e, cap, lb);
      const third = g.solve();
      expect(Array.from(third.flows)).toEqual(Array.from(first.flows));
      expect(third.cost).toBe(first.cost);
    }
  });
});

describe("MinCostMaxFlow API", () => {
  it("is deterministic: same network, same flows", () => {
    for (const seed of [3, 17, 42, 99, 123]) {
      const inst = randomInstance(seed);
      const a = solveInstance(inst);
      const b = solveInstance(inst);
      const g = build(inst);
      const c1 = g.solve();
      const c2 = g.solve();
      expect(Array.from(a.flows)).toEqual(Array.from(b.flows));
      expect(Array.from(c1.flows)).toEqual(Array.from(a.flows));
      expect(Array.from(c2.flows)).toEqual(Array.from(a.flows));
    }
  });

  it("solves HotCRP's own t_mincostmaxflow example (u0 p1, u1 p2, u2 p0)", () => {
    const g = new MinCostMaxFlow();
    const u = [g.addNode(), g.addNode(), g.addNode()];
    const p = [g.addNode(), g.addNode(), g.addNode()];
    for (const x of u) g.addEdge(g.source, x, 1, 0);
    for (const x of p) g.addEdge(x, g.sink, 1, 0);
    const pairs: [number, number, number][] = [
      [0, 0, 0],
      [0, 1, -1],
      [1, 0, 0],
      [1, 1, 0],
      [1, 2, 0],
      [2, 0, 0],
      [2, 2, 1],
    ];
    const edges = pairs.map(([i, j, c]) => g.addEdge(u[i]!, p[j]!, 1, c));
    const r = g.solve();
    const chosen = pairs.filter((_, k) => r.flows[edges[k]!] === 1).map(([i, j]) => `u${i} p${j}`);
    expect(chosen).toEqual(["u0 p1", "u1 p2", "u2 p0"]);
    expect(r.maxFlow).toBe(3);
    expect(r.cost).toBe(-1);
  });

  it("honors lower bounds even when a slot bonus would prefer otherwise", () => {
    const g = new MinCostMaxFlow();
    const r1 = g.addNode();
    const r2 = g.addNode();
    const p = g.addNode();
    g.addEdge(g.source, r1, 1, 0);
    g.addEdge(g.source, r2, 1, 0);
    const pinned = g.addEdge(r1, p, 1, 50, 1); // costly, but pinned
    const better = g.addEdge(r2, p, 1, -50);
    g.addEdge(p, g.sink, 1, 0);
    const r = g.solve();
    expect(r.feasible).toBe(true);
    expect(r.flows[pinned]).toBe(1);
    expect(r.flows[better]).toBe(0);
    expect(r.cost).toBe(50);
  });

  it("reports infeasible lower bounds instead of throwing", () => {
    // p.senior -> p needs 2 units, but only one senior reviewer can reach p.senior.
    const g = new MinCostMaxFlow();
    const senior = g.addNode();
    const pSenior = g.addNode();
    const p = g.addNode();
    g.addEdge(g.source, senior, 5, 0);
    g.addEdge(senior, pSenior, 1, -10);
    g.addEdge(pSenior, p, 2, 0, 2);
    g.addEdge(p, g.sink, 3, 0);
    const r = g.solve();
    expect(r.feasible).toBe(false);
    // Both ends of the forced edge: p.senior can't get the unit, and p would
    // have to absorb a unit that isn't there.
    expect(r.unmet).toEqual([
      { node: pSenior, need: "inflow", amount: 1 },
      { node: p, need: "outflow", amount: 1 },
    ]);
    expect(r.maxFlow).toBe(0);
    expect(r.cost).toBe(0);
  });

  it("finds the true maximum where HotCRP's max-flow phase falls short (hotcrpCompat reproduces PHP)", () => {
    // Differential seed 1921: PHP returns 13 (cost -127); the maximum is 14 (cost -103).
    const inst = randomInstance(1921);
    const fixed = build(inst).solve();
    const compat = build(inst, { hotcrpCompat: true }).solve();
    expect([fixed.maxFlow, fixed.cost]).toEqual([14, -103]);
    expect([compat.maxFlow, compat.cost]).toEqual([13, -127]);
    expect(checkFlow(inst, compat.flows).ok).toBe(true);
  });

  it("rejects malformed networks", () => {
    const g = new MinCostMaxFlow();
    const a = g.addNode();
    expect(() => g.addEdge(a, a, 1)).toThrow(/self-loop/);
    expect(() => g.addEdge(a, g.source, 1)).toThrow(/into the source/);
    expect(() => g.addEdge(g.sink, a, 1)).toThrow(/out of the sink/);
    expect(() => g.addEdge(a, 99, 1)).toThrow(RangeError);
    expect(() => g.addEdge(a, g.sink, 1, 0, 2)).toThrow(/lower bound/);
    expect(() => g.addEdge(a, g.sink, 1.5)).toThrow(/capacity/);
    expect(() => g.addEdge(a, g.sink, 1, 2 ** 31)).toThrow(/cost/);
    const big = new MinCostMaxFlow();
    const b = big.addNode();
    for (let i = 0; i < 5000; ++i) big.addEdge(big.source, b, 2 ** 31 - 1, 2 ** 31 - 1);
    big.addEdge(b, big.sink, 1);
    expect(() => big.solve()).toThrow(/2\^53/);
  });

  it("handles an empty network", () => {
    const r = new MinCostMaxFlow().solve();
    expect(r).toMatchObject({ feasible: true, maxFlow: 0, cost: 0 });
  });
});
