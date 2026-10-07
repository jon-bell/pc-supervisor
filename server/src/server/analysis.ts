// The rules evaluated over the whole store, cached between requests.
//
// Rebuilding means one buildSnapshot() (six SQL statements) plus one
// analyze() pass, both linear in the store. The cache key is the latest
// sync_run id (sync or backfill) and the clock's current minute, so a sync,
// a backfill, or the passage of time re-ranks; a pinned clock (PCS_NOW)
// keeps the key stable. Routes for M6 (/api/acs, /api/reviewers, people,
// overview) read the same Analysis: it already holds AC and reviewer metrics
// and the burndown.

import type { Clock } from "../clock.js";
import type { Config } from "../config.js";
import { analyze, ruleContextFromConfig, type Analysis, type PersonView, type RuleContext, type SnapshotView } from "../rules/index.js";
import type { Store } from "../store/store.js";
import { buildSnapshot } from "../views/snapshot.js";

export interface AnalysisView {
  snapshot: SnapshotView;
  analysis: Analysis;
  ctx: RuleContext;
  people: ReadonlyMap<string, PersonView>;
}

export class AnalysisSource {
  #key: string | undefined;
  #view: AnalysisView | undefined;

  constructor(
    private readonly store: Store,
    private readonly cfg: Config,
    private readonly clock: Clock,
  ) {}

  get(): AnalysisView {
    const ctx = ruleContextFromConfig(this.cfg, this.clock);
    const run = this.store.db.prepare("select coalesce(max(id), 0) as id from sync_run where finished_at is not null").get() as {
      id: number;
    };
    const key = `${run.id}:${Math.floor(ctx.now / 60_000)}`;
    if (this.#view && this.#key === key) return this.#view;
    const snapshot = buildSnapshot(this.store, { fields: this.cfg.fields, acRole: this.cfg.acRole });
    const analysis = analyze(snapshot, ctx);
    this.#view = { snapshot, analysis, ctx, people: analysis.evaluation.index.people };
    this.#key = key;
    return this.#view;
  }

  invalidate(): void {
    this.#key = undefined;
    this.#view = undefined;
  }
}
