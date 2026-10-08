// The rules evaluated over the whole store, cached between requests.
//
// Rebuilding means one buildSnapshot() (six SQL statements) plus one
// analyze() pass, both linear in the store. The cache key is the latest
// sync_run id (sync or backfill) and the clock's current minute, so a sync,
// a backfill, or the passage of time re-ranks; a pinned clock (PCS_NOW)
// keeps the key stable. Routes for M6 (/api/acs, /api/reviewers, people,
// overview) read the same Analysis: it already holds AC and reviewer metrics
// and the burndown.
//
// get({ pids }) is the same evaluation over only those papers (the in-app
// ?search= filter, paper-filter.ts), so AC and reviewer aggregates count only
// them. A few recent subsets are cached under the same key.

import type { Clock } from "../clock.js";
import { excludedRounds, type Config } from "../config.js";
import { analyze, ruleContextFromConfig, type Analysis, type PersonView, type RuleContext, type SnapshotView } from "../rules/index.js";
import type { Store } from "../store/store.js";
import { buildSnapshot } from "../views/snapshot.js";

export interface AnalysisView {
  snapshot: SnapshotView;
  analysis: Analysis;
  ctx: RuleContext;
  people: ReadonlyMap<string, PersonView>;
}

/** How the last rebuild went, for the Server-Timing header (app.ts). */
export interface AnalysisStats {
  /** Rebuilds since start; a request that bumps it paid for one. */
  builds: number;
  snapshotMs: number;
  rulesMs: number;
}

/** Filtered analyses kept per cache key (most recent first out). */
const SUBSET_CACHE = 8;

export class AnalysisSource {
  #key: string | undefined;
  #view: AnalysisView | undefined;
  #subsets = new Map<string, AnalysisView>();
  readonly stats: AnalysisStats = { builds: 0, snapshotMs: 0, rulesMs: 0 };

  constructor(
    private readonly store: Store,
    private readonly cfg: Config,
    private readonly clock: Clock,
  ) {}

  /** The whole store, or with `pids` only those papers. */
  get(o: { pids?: readonly number[] } = {}): AnalysisView {
    const ctx = ruleContextFromConfig(this.cfg, this.clock);
    const run = this.store.db.prepare("select coalesce(max(id), 0) as id from sync_run where finished_at is not null").get() as {
      id: number;
    };
    const key = `${run.id}:${Math.floor(ctx.now / 60_000)}`;
    if (this.#key !== key) {
      this.#view = undefined;
      this.#subsets.clear();
    }
    if (o.pids) return this.#subset(key, ctx, o.pids);
    if (this.#view && this.#key === key) return this.#view;
    const t0 = performance.now();
    const snapshot = buildSnapshot(this.store, { fields: this.cfg.fields, acRole: this.cfg.acRole, excludeRounds: excludedRounds(this.cfg) });
    const t1 = performance.now();
    const analysis = analyze(snapshot, ctx);
    this.stats.builds++;
    this.stats.snapshotMs = t1 - t0;
    this.stats.rulesMs = performance.now() - t1;
    this.#view = { snapshot, analysis, ctx, people: analysis.evaluation.index.people };
    this.#key = key;
    return this.#view;
  }

  #subset(key: string, ctx: RuleContext, pids: readonly number[]): AnalysisView {
    const sorted = [...new Set(pids)].sort((a, b) => a - b);
    const id = sorted.join(",");
    const hit = this.#subsets.get(id);
    if (hit) {
      this.#subsets.delete(id); // refresh its place
      this.#subsets.set(id, hit);
      return hit;
    }
    this.#key = key;
    const t0 = performance.now();
    const snapshot = buildSnapshot(this.store, {
      fields: this.cfg.fields,
      acRole: this.cfg.acRole,
      excludeRounds: excludedRounds(this.cfg),
      pids: sorted,
    });
    const t1 = performance.now();
    const analysis = analyze(snapshot, ctx);
    this.stats.builds++;
    this.stats.snapshotMs = t1 - t0;
    this.stats.rulesMs = performance.now() - t1;
    const view = { snapshot, analysis, ctx, people: analysis.evaluation.index.people };
    this.#subsets.set(id, view);
    while (this.#subsets.size > SUBSET_CACHE) this.#subsets.delete(this.#subsets.keys().next().value!);
    return view;
  }

  invalidate(): void {
    this.#key = undefined;
    this.#view = undefined;
    this.#subsets.clear();
  }
}
