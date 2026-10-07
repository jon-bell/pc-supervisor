// TPMS file exchange (spec §10.3): the export bundle for the TPMS operator.
// Imports (tpms-assignments, tpms-scores, affinity-local, tpms-registrations)
// live in ../../imports/; the merged affinity lookup is imports/scores.ts.
//
//   const bundle = await tpmsExport(store, cfg, client);   // reads the store, fetches get/pcconf

import { DEFAULT_ASSIGNMENT_POLICY, type Config } from "../../config.js";
import type { HotcrpClient } from "../../hotcrp/client.js";
import type { Store } from "../../store/store.js";
import { buildTpmsBundle, type TpmsBundle } from "./export.js";

export { buildTpmsBundle, type TpmsBundle, type TpmsBundleInput, type TpmsFile } from "./export.js";

/**
 * The bundle from the local store (PC, tiers, ACs; run `pcs sync` first) and
 * HotCRP's live PC conflicts for submitted papers (one read-only request).
 */
export async function tpmsExport(
  store: Store,
  cfg: Pick<Config, "acRole"> & { assignment?: Config["assignment"] },
  client: Pick<HotcrpClient, "pcConflicts">,
): Promise<TpmsBundle> {
  const conflicts = await client.pcConflicts({ q: "all", t: "s" });
  return buildTpmsBundle({
    people: store.people({ includeGone: false }),
    acs: new Set(store.areaChairs(cfg.acRole).map((r) => r.email)),
    conflicts,
    policy: cfg.assignment ?? DEFAULT_ASSIGNMENT_POLICY,
  });
}
