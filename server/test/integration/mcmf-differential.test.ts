// PLAN M10a done criterion: the TypeScript MinCostMaxFlow port against
// HotCRP's PHP MinCostMaxFlow, run in the harness container, on random
// instances (with and without lower bounds, feasible and infeasible).
//
// Three solvers per instance:
//   ts     the port as shipped (source label pinned, feasibility phase);
//   compat the port with { hotcrpCompat: true } (PHP's max-flow phase);
//   php    HotCRP's lib/mincostmaxflow.php via seed/php/mcmf-driver.php;
// plus the slow reference solver (test/support/mcmf-instances.ts).
//
// Every instance must land in one of these classes:
//   agree        PHP's result is a valid flow (or PHP says infeasible) and
//                matches the reference; ts matches both exactly (cost,
//                max-flow value, feasibility).
//   php-short    PHP returns a valid flow whose value is below the maximum
//                (the source-relabel defect, mcmf.ts file comment); compat
//                reproduces PHP exactly, ts matches the reference.
//   php-deficit  PHP's start leaves a lower-bound deficit and PHP returns a
//                non-conserving flow or never terminates; ts used its
//                feasibility start (or found the instance infeasible) and
//                matches the reference.
// Anything else fails. At least 200 instances must agree.

import { beforeAll, describe, expect, it } from "vitest";
import { MinCostMaxFlow } from "../../src/modules/solver/mcmf.js";
import { checkFlow, randomInstance, referenceSolve, solveInstance, type Instance } from "../support/mcmf-instances.js";
import { phpMcmfRunner, type PhpResult } from "../support/php-mcmf.js";

const SEEDS = Array.from({ length: 400 }, (_, i) => 10_001 + i);

function solveCompat(inst: Instance) {
  const g = new MinCostMaxFlow({ hotcrpCompat: true });
  g.addNodes(inst.n - 2);
  for (const [s, d, c, k, lb] of inst.edges) g.addEdge(s, d, c, k, lb);
  return g.solve();
}

type Klass = "agree" | "php-short" | "php-deficit";

describe("MinCostMaxFlow port vs HotCRP's PHP (harness container)", () => {
  let php: PhpResult[] = [];
  const instances = SEEDS.map(randomInstance);

  beforeAll(async () => {
    const run = await phpMcmfRunner();
    php = [];
    for (let i = 0; i < instances.length; i += 100) php.push(...(await run(instances.slice(i, i + 100))));
  }, 120_000);

  it("agrees on ≥ 200 instances, and every disagreement is a documented PHP defect", () => {
    const counts: Record<string, Record<Klass, number>> = {};
    let identicalFlows = 0;
    let comparableFlows = 0;
    let agreeFeasible = 0;
    let agreeInfeasible = 0;
    let withLower = 0;

    instances.forEach((inst, i) => {
      const p = php[i]!;
      const ref = referenceSolve(inst);
      const ts = solveInstance(inst);
      const where = `seed ${SEEDS[i]} (${inst.kind})`;
      if (inst.edges.some((e) => e[4] > 0)) ++withLower;

      // The shipped port always matches the reference, and its flow is valid.
      expect(ts.feasible, where).toBe(ref.feasible);
      if (ts.feasible) {
        const chk = checkFlow(inst, ts.flows);
        expect(chk.problems, where).toEqual([]);
        expect(ts.maxFlow, where).toBe(ref.maxFlow);
        expect(ts.cost, where).toBe(ref.cost);
        expect(chk.cost, where).toBe(ts.cost);
        expect(ts.precisionLimited, where).toBe(false);
      } else {
        expect(ts.unmet.length, where).toBeGreaterThan(0);
      }

      let klass: Klass;
      const phpValid = p.status === "ok" && p.conserving && p.bounded;
      if (phpValid && ref.feasible && p.maxflow === ref.maxFlow) {
        klass = "agree";
        expect(p.cost, where).toBe(ref.cost);
        expect(ts.cost, where).toBe(p.cost);
        expect(ts.maxFlow, where).toBe(p.maxflow);
        ++agreeFeasible;
      } else if (p.status === "infeasible" && !ref.feasible) {
        klass = "agree";
        ++agreeInfeasible;
      } else if (phpValid && ref.feasible && p.maxflow < ref.maxFlow) {
        klass = "php-short";
      } else if (!phpValid && (ts.stats.feasibilityStart || !ts.feasible)) {
        klass = "php-deficit";
      } else {
        throw new Error(`${where}: unexplained: php ${JSON.stringify({ ...p, flows: undefined })}, ref ${ref.feasible} ${ref.maxFlow} ${ref.cost}`);
      }
      (counts[inst.kind] ??= { agree: 0, "php-short": 0, "php-deficit": 0 })[klass]++;

      // Port fidelity: with PHP's max-flow phase and PHP's starting flow, a
      // valid PHP result is reproduced exactly, edge for edge.
      // (A feasibility start is a different starting flow, so not comparable.)
      if (phpValid) {
        const c = solveCompat(inst);
        if (!c.stats.feasibilityStart) {
          expect(c.feasible, where).toBe(true);
          expect(c.maxFlow, where).toBe(p.maxflow);
          expect(c.cost, where).toBe(p.cost);
          ++comparableFlows;
          if (Array.from(c.flows).every((f, e) => f === p.flows[e])) ++identicalFlows;
        }
      }
    });

    const agree = agreeFeasible + agreeInfeasible;
    console.log(
      `mcmf differential: ${instances.length} instances (${withLower} with lower bounds); ` +
        `agree ${agree} (${agreeFeasible} feasible, ${agreeInfeasible} infeasible); ` +
        `compat flows identical to PHP on ${identicalFlows}/${comparableFlows}\n` +
        Object.entries(counts)
          .map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`)
          .join("\n"),
    );
    expect(agree).toBeGreaterThanOrEqual(200);
    expect(agreeInfeasible).toBeGreaterThan(0);
    // Two-layer assignment networks (HotCRP's shape) never hit the
    // source-relabel defect; without lower bounds they agree outright.
    for (const k of ["layered", "layered+lb", "tier-soft", "tier-hard"]) {
      expect(counts[k]?.agree ?? 0, k).toBeGreaterThan(0);
      expect(counts[k]?.["php-short"] ?? 0, k).toBe(0);
    }
    for (const k of ["layered", "tier-soft", "general"]) expect(counts[k]?.["php-deficit"] ?? 0, k).toBe(0);
    expect(identicalFlows).toBe(comparableFlows);
  });
});
