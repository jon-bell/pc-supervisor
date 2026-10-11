// The affinity matrix in force at an instant (spec §10.3 `tpms-scores` and
// `affinity-local`), as a compact in-memory lookup for the assignment solver
// (PLAN M10b) and the validator's tie-breakers.
//
//   const s = scoresAsOf(db, clock.now());
//   s.score(12, "ana@example.org")   // 0.83, or null if unscored
//   s.topK(12, 10)                   // the 10 best-scoring reviewers of #12
//   s.row(12)                        // Float64Array over s.emails (NaN = unscored)
//
// Merging: the latest tpms-scores run and the latest affinity-local run as of
// `at` are combined per (paper, reviewer) pair. A TPMS score wins; a local
// (openreview-expertise) score fills only pairs TPMS didn't score, which is
// the cold-start case (a reviewer without a TPMS profile). Both are on 0-1,
// but they come from different models and are not calibrated against each
// other; `source()` says which one a score came from.
//
// Memory: one Float64Array of papers x reviewers plus one byte per cell for
// the source: 2,400 x 600 is about 13 MB. Rows are streamed from SQLite
// (`iterate`), never materialized as objects.

import type { Db } from "../store/db.js";
import { runAsOf, type ImportRun } from "./store.js";

export type ScoreSource = "tpms" | "local";

export interface ScoredReviewer {
  email: string;
  score: number;
  source: ScoreSource;
}

export interface AffinityScores {
  /** The runs in force at `at` (undefined = no such import yet). */
  readonly runs: { readonly tpms: ImportRun | undefined; readonly local: ImportRun | undefined };
  /** Every scored paper, ascending. */
  readonly pids: readonly number[];
  /** Every scored reviewer (lowercased emails), ascending; the column order of row(). */
  readonly emails: readonly string[];
  /** Scored (paper, reviewer) pairs after merging. */
  readonly pairs: number;
  /** Index into pids, or -1. */
  paperIndex(pid: number): number;
  /** Index into emails, or -1 (case-insensitive). */
  reviewerIndex(email: string): number;
  score(pid: number, email: string): number | null;
  source(pid: number, email: string): ScoreSource | null;
  /** Scores of `pid` over `emails` (NaN = unscored); a view into the matrix, don't modify it. */
  row(pid: number): Float64Array | undefined;
  /**
   * The k best-scoring reviewers of `pid`, best first (ties: email ascending).
   * `exclude` skips reviewers (e.g. conflicts, wrong tier) before ranking.
   */
  topK(pid: number, k: number, exclude?: (email: string) => boolean): ScoredReviewer[];
}

export interface ScoresOptions {
  /** Which kinds to merge. Default both. */
  sources?: readonly ScoreSource[];
}

const SOURCE_CODE: Record<ScoreSource, number> = { tpms: 1, local: 2 };
const CODE_SOURCE: readonly (ScoreSource | null)[] = [null, "tpms", "local"];

/** The merged affinity matrix as of `at` (see the file comment). */
export function scoresAsOf(db: Db, at: Date, opts: ScoresOptions = {}): AffinityScores {
  const want = new Set(opts.sources ?? ["tpms", "local"]);
  const tpms = want.has("tpms") ? runAsOf(db, "tpms-scores", at) : undefined;
  const local = want.has("local") ? runAsOf(db, "affinity-local", at) : undefined;
  const ids = [tpms?.id, local?.id].filter((x): x is number => x !== undefined);
  const inRuns = `run_id in (${ids.map(() => "?").join(", ") || "null"})`;

  const pids = (db.prepare(`select distinct pid from import_score where ${inRuns} order by pid`).pluck().all(...ids) as number[]);
  const emails = (db.prepare(`select distinct email from import_score where ${inRuns} order by email`).pluck().all(...ids) as string[]);
  const pIdx = new Map(pids.map((p, i) => [p, i]));
  const eIdx = new Map(emails.map((e, i) => [e, i]));
  const R = emails.length;
  const cells = new Float64Array(pids.length * R).fill(NaN);
  const src = new Uint8Array(pids.length * R);
  let pairs = 0;

  // Local first, then TPMS over it: a TPMS score wins.
  const load = (run: ImportRun | undefined, code: number) => {
    if (!run) return;
    const it = db.prepare("select pid, email, score from import_score where run_id = ?").raw().iterate(run.id) as Iterable<
      [number, string, number]
    >;
    for (const [pid, email, score] of it) {
      const c = pIdx.get(pid)! * R + eIdx.get(email)!;
      if (src[c] === 0) pairs++;
      cells[c] = score;
      src[c] = code;
    }
  };
  load(local, SOURCE_CODE.local);
  load(tpms, SOURCE_CODE.tpms);

  const cell = (pid: number, email: string): number => {
    const p = pIdx.get(pid);
    const e = eIdx.get(email.toLowerCase());
    return p === undefined || e === undefined ? -1 : p * R + e;
  };

  return {
    runs: { tpms, local },
    pids,
    emails,
    pairs,
    paperIndex: (pid) => pIdx.get(pid) ?? -1,
    reviewerIndex: (email) => eIdx.get(email.toLowerCase()) ?? -1,
    score(pid, email) {
      const c = cell(pid, email);
      return c < 0 || src[c] === 0 ? null : cells[c]!;
    },
    source(pid, email) {
      const c = cell(pid, email);
      return c < 0 ? null : CODE_SOURCE[src[c]!]!;
    },
    row(pid) {
      const p = pIdx.get(pid);
      return p === undefined ? undefined : cells.subarray(p * R, (p + 1) * R);
    },
    topK(pid, k, exclude) {
      const p = pIdx.get(pid);
      if (p === undefined || k <= 0) return [];
      // Keep the best k in a small sorted array: O(R log k)-ish for small k.
      const best: number[] = [];
      const better = (a: number, b: number) => cells[p * R + a]! > cells[p * R + b]! || (cells[p * R + a] === cells[p * R + b] && a < b);
      for (let e = 0; e < R; e++) {
        if (src[p * R + e] === 0 || (exclude && exclude(emails[e]!))) continue;
        if (best.length === k && !better(e, best[k - 1]!)) continue;
        let lo = 0;
        let hi = best.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (better(e, best[mid]!)) hi = mid;
          else lo = mid + 1;
        }
        best.splice(lo, 0, e);
        if (best.length > k) best.pop();
      }
      return best.map((e) => ({ email: emails[e]!, score: cells[p * R + e]!, source: CODE_SOURCE[src[p * R + e]!]! }));
    },
  };
}
