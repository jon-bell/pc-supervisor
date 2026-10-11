// Responses of the assignment routes (routes/assignment.ts; spec §10.4 C,
// §10.5). Unlike api-types.ts these reuse the module report types directly
// (type-only imports), as the tier-progress view does.

import type { AssignmentReport } from "../modules/assignment/types.js";
import type { SolveReport } from "../modules/solver/types.js";
import type { ModuleResponseBase } from "./api-types.js";

export type { AssignmentReport, SolveReport };

/** GET /api/assignment */
export interface AssignmentResponse extends ModuleResponseBase {
  report: AssignmentReport;
}

/** GET and POST /api/assignment/solve */
export interface SolveResponse extends ModuleResponseBase {
  /** The last solve's report; null until the solver has run in this server. */
  report: SolveReport | null;
  /** Epoch ms (app clock) of that solve. */
  computedAt: number | null;
  running: boolean;
  /** False when the server has no HotCRP client for the solver (POST answers 503). */
  available: boolean;
}
