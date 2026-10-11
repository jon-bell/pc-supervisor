// PLAN M7 budgets. Every one is an assertion in `npm run test:scale`.
// Server and browser timings are measured on the same machine as the harness
// (CI: ripley-cloud-large), so they include no WAN latency.

export const SCALE_PORT = 5328;

export const BUDGET = {
  /** `seed reset` + `seed scale` on a fresh harness (PLAN M2: under 15 minutes). */
  seedMs: 15 * 60_000,
  /** Full sync into an empty store, against the harness. */
  fullSyncMs: 5 * 60_000,
  /** Re-sync with nothing changed in HotCRP. */
  resyncMs: 2 * 60_000,
  /** First analyze()-backed API response after `pcs serve` starts (snapshot + rules). */
  apiColdMs: 1_000,
  /** Any analyze()-backed API response once the analysis is cached. */
  apiWarmMs: 150,
  /** Process report or pseudonymous export over the whole store (PLAN M13; computed on demand, not cached). */
  reportMs: 3_000,
  /** Triage list: navigation start to the first rows painted (warm server). */
  renderMs: 300,
  /** Triage list: filter change to the filtered rows painted. */
  filterMs: 300,
  /** Scripted scroll through the virtualized list (median of 3 passes): worst long task. */
  scrollMaxLongTaskMs: 100,
  /** Scripted scroll: 95th-percentile frame interval (≈ 30 fps or better). */
  scrollP95FrameMs: 34,
} as const;

/** Where the Playwright perf spec writes its measurements for run.ts. */
export const PERF_RESULT_FILE = "scale-perf.json";

export interface PerfResult {
  renderMs: number;
  renderRows: number;
  /** Time from the /api/triage response arriving to rows painted. */
  renderAfterDataMs: number;
  triageBytes: number;
  filters: { name: string; ms: number; rows: number }[];
  /** The median of three scroll passes (by p95 frame interval). */
  scroll: {
    frames: number;
    p50FrameMs: number;
    p95FrameMs: number;
    maxFrameMs: number;
    longTasks: number;
    maxLongTaskMs: number;
    px: number;
    passesP95Ms: number[];
  };
}
