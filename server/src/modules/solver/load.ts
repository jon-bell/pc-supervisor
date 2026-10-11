// Build the solver's input (spec §10.5): the validator's view of the local
// store and imports (M10's loadValidatorInput: live papers with authors,
// people with tiers, current slot-filling assignments with review status,
// the latest invites and do-not-invite imports), the merged tpms-scores +
// affinity-local matrix as of `at`, and two read-only HotCRP downloads made
// on demand and never stored: PC conflicts (get/pcconf) and, unless
// PCS_SOLVER_W_HOTCRP=0, review preferences (get/allrevpref).

import { excludedRounds, type Config, type QuickRejectPolicy, type SolverSettings } from "../../config.js";
import type { PcConflictRow, RevPrefRow } from "../../hotcrp/schemas.js";
import { runAsOf } from "../../imports/store.js";
import { scoresAsOf } from "../../imports/scores.js";
import type { Store } from "../../store/store.js";
import { loadValidatorInput } from "../assignment/load.js";
import type { SolverInput } from "./types.js";

/** The two HotCRP reads the solver needs (HotcrpClient implements both). */
export interface SolverHotcrp {
  pcConflicts(opts: { q?: string; t?: "s" | "all" | "viewable" }): Promise<PcConflictRow[]>;
  allRevPrefs(opts: { q?: string; t?: "s" | "all" | "viewable" }): Promise<RevPrefRow[]>;
}

export async function loadSolverInput(
  store: Store,
  cfg: Pick<Config, "acRole"> & { quickReject?: QuickRejectPolicy | undefined },
  settings: Pick<SolverSettings, "weights">,
  opts: { at: Date; client: SolverHotcrp },
): Promise<SolverInput> {
  const v = loadValidatorInput(store, cfg, { source: "hotcrp", at: opts.at });
  const xr = excludedRounds(cfg);
  const blocked =
    xr.length === 0
      ? []
      : (store.db
          .prepare(
            `select distinct pid, email from assignment
             where removed_seen_at is null and role in ('primary', 'secondary', 'pc')
               and round is not null and lower(round) in (select lower(value) from json_each(?))`,
          )
          .all(JSON.stringify(xr)) as { pid: number; email: string }[]);
  const hasScores = runAsOf(store.db, "tpms-scores", opts.at) !== undefined || runAsOf(store.db, "affinity-local", opts.at) !== undefined;
  const scores = hasScores ? scoresAsOf(store.db, opts.at) : undefined;
  const [conflicts, prefs] = await Promise.all([
    opts.client.pcConflicts({ q: "all", t: "all" }),
    settings.weights.hotcrp > 0 ? opts.client.allRevPrefs({ q: "all", t: "all" }) : Promise.resolve(undefined),
  ]);
  return {
    papers: v.papers,
    people: v.people,
    current: v.current,
    blocked,
    conflicts: conflicts.map((c) => ({ pid: c.pid, email: c.email.toLowerCase() })),
    invites: v.invites,
    doNotInvite: v.doNotInvite,
    scores,
    prefs,
  };
}
