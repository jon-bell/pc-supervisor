// PLAN M10a performance: the 2,400-paper x 600-reviewer pruned network of
// spec §10.5 (top-60 candidates per paper, ~160k edges, ~7.8k vertices)
// must solve in under 30 s in CI. On a 4-core dev machine a solve takes
// ~1-2 s; the budget is the PLAN's 30 s so a loaded CI runner has 15x slack.

import { describe, expect, it } from "vitest";
import { checkFlow, scaleNetwork } from "../../support/mcmf-instances.js";

const BUDGET_MS = 30_000;

describe("MinCostMaxFlow at conference scale", () => {
  for (const hard of [false, true]) {
    it(`solves 2,400 x 600, top-60, ${hard ? "hard lower bounds" : "soft slot bonuses"}, within ${BUDGET_MS / 1000} s`, () => {
      const net = scaleNetwork({ seed: 7, papers: 2400, reviewers: 600, topK: 60, hard });
      expect(net.edges).toBeGreaterThan(150_000);
      const t0 = performance.now();
      const r = net.g.solve();
      const solveMs = performance.now() - t0;

      expect(r.feasible).toBe(true);
      expect(r.precisionLimited).toBe(false);
      expect(r.maxFlow).toBe(2400 * 3);
      // Flow validity on the real network.
      const edges = Array.from({ length: net.edges }, (_, e) => {
        const x = net.g.edge(e);
        return [x.src, x.dst, x.cap, x.cost, x.minCap] as [number, number, number, number, number];
      });
      const chk = checkFlow({ n: net.nodes, edges, kind: "scale" }, r.flows);
      expect(chk.problems.slice(0, 5)).toEqual([]);
      expect(chk.cost).toBe(r.cost);

      // A repair-loop step: forbid a used candidate edge and solve again.
      const used = edges.findIndex(([s, , , c], e) => s >= 2 && s < 602 && c < 0 && r.flows[e] === 1);
      net.g.forbid(used);
      const t1 = performance.now();
      const r2 = net.g.solve();
      const resolveMs = performance.now() - t1;
      expect(r2.feasible).toBe(true);
      expect(r2.flows[used]).toBe(0);
      expect(r2.cost).toBeGreaterThanOrEqual(r.cost);

      console.log(
        `mcmf scale (${hard ? "hard" : "soft"}): ${net.nodes} vertices, ${net.edges} edges; ` +
          `solve ${Math.round(solveMs)} ms, re-solve after forbid ${Math.round(resolveMs)} ms; ` +
          `${r.stats.refinePhases} refine phases, ${r.stats.pushes} pushes, ${r.stats.relabels} relabels`,
      );
      expect(solveMs).toBeLessThan(BUDGET_MS);
      expect(resolveMs).toBeLessThan(BUDGET_MS);
    }, 4 * BUDGET_MS);
  }
});
