// Assignment validator (spec §10.4 C, PLAN M10): the module's public API.
//
// For the server (M5/M6), e.g. a GET /api/assignment route:
//
//   import { validateAssignments } from "../modules/assignment/index.js";
//   const report = validateAssignments(store, cfg, { source: "hotcrp", clock });
//   // report.findings: [{ check, code, pid?, emails, reason, dropped? }]
//   // report.fixup.csv: the HotCRP assignment CSV (dry-run it first)
//
// Read-only and synchronous over the local store; it never calls HotCRP.
// The report holds emails, pids, affiliations, and counts, never review or
// comment text. Findings are for a human; nothing is auto-applied.

import type { Clock } from "../../clock.js";
import { DEFAULT_ASSIGNMENT_POLICY, type AssignmentPolicy, type Config, type QuickRejectPolicy } from "../../config.js";
import type { Store } from "../../store/store.js";
import type { CoauthorshipSource } from "./dblp.js";
import { loadValidatorInput } from "./load.js";
import type { AssignmentReport, AssignmentSource } from "./types.js";
import { validate } from "./validate.js";

export type * from "./types.js";
export { NoTpmsImportError, loadValidatorInput } from "./load.js";
export { validate } from "./validate.js";
export { findCycles } from "./cycles.js";
export { NO_COAUTHORSHIP, staticCoauthorship, type CoauthorshipSource } from "./dblp.js";

export interface ValidateOptions {
  /** "hotcrp" = the current assignment in the store; "tpms" = the latest tpms-assignments import. */
  source: AssignmentSource;
  /** App clock (PCS_NOW); imports are read as of clock.now(). */
  clock: Clock;
  coauthors?: CoauthorshipSource;
}

/** Validate an assignment from the store. Throws NoTpmsImportError for source "tpms" without an import. */
export function validateAssignments(
  store: Store,
  cfg: Pick<Config, "acRole"> & { assignment?: AssignmentPolicy | undefined; quickReject?: QuickRejectPolicy | undefined },
  opts: ValidateOptions,
): AssignmentReport {
  const input = loadValidatorInput(store, cfg, {
    source: opts.source,
    at: opts.clock.now(),
    ...(opts.coauthors ? { coauthors: opts.coauthors } : {}),
  });
  return validate(input, cfg.assignment ?? DEFAULT_ASSIGNMENT_POLICY);
}
