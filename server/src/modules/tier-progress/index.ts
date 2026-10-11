// Reviewing progress by tier (spec §10.4 D, PLAN M12): the module's public API.
//
//   import { tierProgress } from "../modules/tier-progress/index.js";
//   const report = tierProgress(store, cfg, clock);           // CLI
//   const report = tierProgressFrom(view, store, cfg);        // server (cached analysis)
//
// Read-only over the local store; never calls HotCRP. The report holds pids,
// emails, names, titles, and counts, never review or comment text.

import type { Clock } from "../../clock.js";
import { DEFAULT_TIER_PROGRESS_POLICY, type Config } from "../../config.js";
import { analyze, type Analysis, type RuleContext } from "../../rules/index.js";
import { effectiveRuleContext } from "../../rule-settings/service.js";
import type { Db } from "../../store/db.js";
import type { Store } from "../../store/store.js";
import { buildSnapshot } from "../../views/snapshot.js";
import { computeTierProgress } from "./compute.js";
import type { TierProgressReport } from "./types.js";

export type * from "./types.js";
export { computeTierProgress, hotcrpReviewPath, submittedAt, type TierProgressInput } from "./compute.js";

export interface StoreExtras {
  /** Author email -> pids (live papers, current authors with an email). */
  authored: Map<string, number[]>;
  /** Live reviews whose first_seen_at is approximate (present at the first sync). */
  approxRids: Set<number>;
}

/** Two indexed scans: paper_author (M10) and the review first-seen flags. */
export function loadStoreExtras(db: Db): StoreExtras {
  const authored = new Map<string, number[]>();
  for (const r of db
    .prepare(
      `select a.email, a.pid from paper_author a join paper p on p.pid = a.pid
        where a.removed_seen_at is null and a.email is not null and p.deleted_seen_at is null
        order by a.email, a.pid`,
    )
    .all() as { email: string; pid: number }[]) {
    const list = authored.get(r.email);
    if (list) {
      if (list[list.length - 1] !== r.pid) list.push(r.pid);
    } else authored.set(r.email, [r.pid]);
  }
  const approxRids = new Set(
    (db.prepare("select rid from review where first_seen_approx = 1 and deleted_seen_at is null").all() as { rid: number }[]).map((r) => r.rid),
  );
  return { authored, approxRids };
}

type ModuleConfig = Pick<Config, "tierTags" | "tierProgress">;

/** From an already-evaluated analysis (the server's cached one). */
export function tierProgressFrom(
  view: { analysis: Analysis; ctx: RuleContext },
  store: Store,
  cfg: ModuleConfig,
): TierProgressReport {
  const extras = loadStoreExtras(store.db);
  return computeTierProgress(
    {
      index: view.analysis.evaluation.index,
      authored: extras.authored,
      approxRids: extras.approxRids,
      reviewers: view.analysis.reviewers,
      tierOrder: ["senior", ...Object.keys(cfg.tierTags)],
    },
    view.ctx,
    cfg.tierProgress ?? DEFAULT_TIER_PROGRESS_POLICY,
  );
}

/** Build the snapshot, evaluate, and report (the CLI and tests). */
export function tierProgress(store: Store, cfg: Config, clock: Clock): TierProgressReport {
  const ctx = effectiveRuleContext(store, cfg, clock);
  const analysis = analyze(buildSnapshot(store, { fields: cfg.fields, acRole: cfg.acRole }), ctx);
  return tierProgressFrom({ analysis, ctx }, store, cfg);
}
