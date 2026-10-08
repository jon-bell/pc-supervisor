// PLAN M10b performance: a full 2,400-paper solve of the spec §10.5 network,
// including the repair passes and the validator cross-check, in under 30 s
// (the PLAN's budget). The instance has 600 reviewers (400 senior, 120
// junior, 80 reserve-active), a dense 2,400 x 600 score matrix, PC members
// among the authors (so reciprocal cycles occur), 200 affiliations, HotCRP
// conflicts, current assignments (some started, hence pinned), and invites
// with activated reserves. Built with M10a's style of seeded generator
// (test/support/solver-instances.ts).

import { describe, expect, it } from "vitest";
import { solve } from "../../../src/modules/solver/solve.js";
import { randomInstance } from "../../support/solver-instances.js";

const BUDGET_MS = 30_000;

describe("assignment solver at conference scale", () => {
  it(`solves 2,400 papers x 600 reviewers, top-60, with repairs, within ${BUDGET_MS / 1000} s`, () => {
    const inst = randomInstance(2400, { papers: 2400, seniors: 400, juniors: 120, reserves: 80, scored: 1, affiliations: 200, current: 0.1, pcAuthors: 1 });
    const settings = { ...inst.settings, topK: 60 };
    const t0 = performance.now();
    const rep = solve(inst.input, inst.policy, settings);
    const ms = performance.now() - t0;
    console.log(
      `solver scale: ${rep.counts.nodes} vertices, ${rep.counts.edges} edges, ${rep.counts.candidates} candidates; ` +
        `build ${Math.round(rep.timing.buildMs)} ms, solves ${rep.timing.solveMs.map((x) => Math.round(x)).join("/")} ms, total ${Math.round(ms)} ms; ` +
        `${rep.repairs.length} repairs (${rep.repairs.filter((r) => r.kind === "cycle").length} cycle), ${rep.unresolved.length} unresolved, ` +
        `${rep.unmet.length} unmet, ${rep.assignments.length} assignments, cross-check ${rep.crossCheck.findings.length} findings (${rep.crossCheck.unexplained} unexplained)`,
    );
    expect(rep.feasible).toBe(true);
    expect(rep.counts.edges).toBeGreaterThan(150_000);
    expect(rep.repairs.length).toBeGreaterThan(0);
    expect(rep.crossCheck.unexplained).toBe(0);
    expect(ms).toBeLessThan(BUDGET_MS);
  }, 4 * BUDGET_MS);
});
