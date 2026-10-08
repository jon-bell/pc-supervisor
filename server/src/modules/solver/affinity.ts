// Affinity normalization for the solver (spec §10.5 "Affinity sources").
//
// Sources, in priority order (the first one that scores a pair wins):
//   1. the tpms-scores import (0-1),
//   2. the affinity-local import (openreview-expertise, 0-1),
//   3. HotCRP preferences / expertise / topic scores (get/allrevpref),
//      mapped to 0-1 by hotcrpScore() below.
// (1) and (2) are already merged that way by imports/scores.ts. Each source
// has a weight (PCS_SOLVER_W_TPMS / _W_LOCAL / _W_HOTCRP), and the integer
// affinity of a pair is round(PCS_SOLVER_AFFINITY_SCALE x weight x score).
// An unscored pair has affinity 0 (source "none"). The solver uses the
// negated affinity as the edge cost.

import type { SolverSettings } from "../../config.js";
import type { RevPrefRow } from "../../hotcrp/schemas.js";
import type { AffinityScores, ScoredReviewer, ScoreSource } from "../../imports/scores.js";
import type { AffinitySource } from "./types.js";

/**
 * A HotCRP preference row as a 0-1 score: 0.5 is "no opinion", the
 * preference moves it by up to +/-0.3 (full strength at +/-PCS_SOLVER_PREF_SCALE),
 * expertise X/Z by +/-0.1, and the topic-interest score (10 = strong interest
 * in the paper's only topic) by up to +/-0.1. Clamped to 0-1.
 */
export function hotcrpScore(r: Pick<RevPrefRow, "preference" | "expertise" | "topicScore">, prefScale: number): number {
  const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
  const exp = r.expertise === "X" ? 1 : r.expertise === "Z" ? -1 : 0;
  const s = 0.5 + 0.3 * clamp(r.preference / prefScale, -1, 1) + 0.1 * exp + 0.1 * clamp(r.topicScore / 10, -1, 1);
  return clamp(s, 0, 1);
}

export interface PairAffinity {
  /** Integer affinity (>= 0). */
  value: number;
  /** The source's own 0-1 score, unweighted (NaN when unscored). */
  raw: number;
  source: AffinitySource;
}

/** Looks up the normalized affinity of (pid, reviewer) pairs; reviewers are given by index into `emails`. */
export class AffinityTable {
  private readonly col: Int32Array;
  private readonly prefs = new Map<number, Map<string, number>>();
  readonly hotcrpRows: number;

  constructor(
    private readonly emails: readonly string[],
    private readonly scores: AffinityScores | undefined,
    prefs: readonly RevPrefRow[] | undefined,
    private readonly s: Pick<SolverSettings, "affinityScale" | "weights" | "prefScale">,
  ) {
    this.col = new Int32Array(emails.length).fill(-1);
    if (scores) emails.forEach((e, i) => (this.col[i] = scores.reviewerIndex(e)));
    let n = 0;
    for (const r of prefs ?? []) {
      if (r.conflict) continue;
      if (r.preference === 0 && r.expertise === null && r.topicScore === 0) continue;
      let m = this.prefs.get(r.pid);
      if (!m) this.prefs.set(r.pid, (m = new Map()));
      m.set(r.email, hotcrpScore(r, s.prefScale));
      n++;
    }
    this.hotcrpRows = n;
  }

  /** A per-paper lookup (fast: one row fetch per paper). */
  forPaper(pid: number): (reviewer: number) => PairAffinity {
    const row = this.scores?.row(pid);
    const pm = this.prefs.get(pid);
    const { affinityScale: scale, weights: w } = this.s;
    return (r) => {
      const c = this.col[r]!;
      if (row && c >= 0) {
        const x = row[c]!;
        if (!Number.isNaN(x)) {
          const src: ScoreSource = this.scores!.source(pid, this.emails[r]!) ?? "tpms";
          return { value: Math.round(scale * w[src] * x), raw: x, source: src };
        }
      }
      const h = pm?.get(this.emails[r]!);
      if (h !== undefined) return { value: Math.round(scale * w.hotcrp * h), raw: h, source: "hotcrp" };
      return { value: 0, raw: NaN, source: "none" };
    };
  }
}

/**
 * An in-memory AffinityScores (same contract as imports/scores.ts) from
 * explicit rows, for tests and generated instances. TPMS rows win over local
 * rows for the same pair.
 */
export function matrixScores(rows: Iterable<{ pid: number; email: string; score: number; source?: ScoreSource }>): AffinityScores {
  const list = [...rows].map((r) => ({ ...r, email: r.email.toLowerCase(), source: r.source ?? "tpms" }));
  const pids = [...new Set(list.map((r) => r.pid))].sort((a, b) => a - b);
  const emails = [...new Set(list.map((r) => r.email))].sort();
  const pIdx = new Map(pids.map((p, i) => [p, i]));
  const eIdx = new Map(emails.map((e, i) => [e, i]));
  const R = emails.length;
  const cells = new Float64Array(pids.length * R).fill(NaN);
  const src: (ScoreSource | null)[] = new Array<ScoreSource | null>(pids.length * R).fill(null);
  let pairs = 0;
  for (const pass of ["local", "tpms"] as const) {
    for (const r of list) {
      if (r.source !== pass) continue;
      const c = pIdx.get(r.pid)! * R + eIdx.get(r.email)!;
      if (src[c] === null) pairs++;
      cells[c] = r.score;
      src[c] = pass;
    }
  }
  const cell = (pid: number, email: string) => {
    const p = pIdx.get(pid);
    const e = eIdx.get(email.toLowerCase());
    return p === undefined || e === undefined ? -1 : p * R + e;
  };
  return {
    runs: { tpms: undefined, local: undefined },
    pids,
    emails,
    pairs,
    paperIndex: (pid) => pIdx.get(pid) ?? -1,
    reviewerIndex: (email) => eIdx.get(email.toLowerCase()) ?? -1,
    score: (pid, email) => {
      const c = cell(pid, email);
      return c < 0 || src[c] === null ? null : cells[c]!;
    },
    source: (pid, email) => {
      const c = cell(pid, email);
      return c < 0 ? null : src[c]!;
    },
    row: (pid) => {
      const p = pIdx.get(pid);
      return p === undefined ? undefined : cells.subarray(p * R, (p + 1) * R);
    },
    topK: (pid, k, exclude) => {
      const p = pIdx.get(pid);
      if (p === undefined) return [];
      const out: ScoredReviewer[] = [];
      for (let e = 0; e < R; e++) {
        const c = p * R + e;
        if (src[c] === null || (exclude && exclude(emails[e]!))) continue;
        out.push({ email: emails[e]!, score: cells[c]!, source: src[c]! });
      }
      out.sort((a, b) => b.score - a.score || a.email.localeCompare(b.email));
      return out.slice(0, Math.max(0, k));
    },
  };
}
