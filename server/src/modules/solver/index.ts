// Assignment solver (spec §10.5, PLAN M10a/b): the module's public API.
//
//   import { solveAssignments } from "../modules/solver/index.js";
//   const report = await solveAssignments(store, cfg, { clock, client });
//   // report.csv: HotCRP bulk-assign CSV (paper,action,email,round); never applied by the tool
//   // report.unmet / load / repairs / coverage / crossCheck: the solve report
//
// Reads the local store and imports, plus two read-only HotCRP downloads
// (PC conflicts, review preferences). The report holds pids, emails,
// affiliations, scores, and counts, never review or comment text.

import type { Clock } from "../../clock.js";
import { DEFAULT_ASSIGNMENT_POLICY, DEFAULT_SOLVER_SETTINGS, type AssignmentPolicy, type Config, type QuickRejectPolicy, type SolverSettings } from "../../config.js";
import type { Store } from "../../store/store.js";
import { loadSolverInput, type SolverHotcrp } from "./load.js";
import { solve } from "./solve.js";
import type { SolveReport } from "./types.js";

export type * from "./types.js";
export { solve, type SolveOptions } from "./solve.js";
export { loadSolverInput, type SolverHotcrp } from "./load.js";
export { AffinityTable, hotcrpScore, matrixScores } from "./affinity.js";
export { MinCostMaxFlow } from "./mcmf.js";

export interface SolveAssignmentsOptions {
  clock: Clock;
  client: SolverHotcrp;
  /** Overrides PCS_SOLVER_HARD. */
  hard?: boolean;
}

export async function solveAssignments(
  store: Store,
  cfg: Pick<Config, "acRole"> & {
    assignment?: AssignmentPolicy | undefined;
    solver?: SolverSettings | undefined;
    quickReject?: QuickRejectPolicy | undefined;
  },
  opts: SolveAssignmentsOptions,
): Promise<SolveReport> {
  const settings = cfg.solver ?? DEFAULT_SOLVER_SETTINGS;
  const input = await loadSolverInput(store, cfg, settings, { at: opts.clock.now(), client: opts.client });
  return solve(input, cfg.assignment ?? DEFAULT_ASSIGNMENT_POLICY, settings, opts.hard === undefined ? {} : { hard: opts.hard });
}
