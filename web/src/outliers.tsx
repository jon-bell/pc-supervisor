// Cohort-relative outlier marks for the people tables (spec §7 "Outlier
// marks"). Each metric says which direction is concerning; a cell is marked
// only when its value lies beyond the cohort's quartile on that side AND at
// least a quarter of the median away from it (or `minGap`), so a tight
// cohort marks no one. Counts are compared per paper when loads differ.
// The bar is derived from the data shown (the rows of the table), not a
// PCS_* threshold: it is a reading aid, not a rule, and never a ranking.
// Columns whose value is the same for every row are flagged `constant` so
// the table can mute them.

import type { ReactNode } from "react";

export type Direction = "higher-better" | "lower-better";

export interface MetricSpec<T> {
  /** Plural noun for the tooltip ("comments", "days to first post"). */
  noun: string;
  direction: Direction;
  value: (row: T) => number | null;
  /** Divide by this (the row's paper load) when loads differ across rows. */
  perPaper?: (row: T) => number;
  /** Smallest gap from the median worth marking, in the metric's unit (default 0). */
  minGap?: number;
  /** Format a value ("33%", "2.5 days"). */
  format?: (v: number) => string;
  /** Who the cohort is ("AC", "lead"). */
  cohort: string;
}

export interface Mark {
  side: "low" | "high";
  text: string;
}

export interface Cohort<T> {
  median: number | null;
  q1: number | null;
  q3: number | null;
  /** Every row has the same value (and there are at least two). */
  constant: boolean;
  mark: (row: T) => Mark | null;
}

/** Linear-interpolation quantile (type 7) of sorted values. */
export function quantile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const h = (sorted.length - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return sorted[lo]! + (h - lo) * (sorted[hi]! - sorted[lo]!);
}

const round = (v: number) => String(Math.round(v * 10) / 10);

/** Cohort statistics for one metric over `rows`; marks need at least 3 rows with a value. */
export function cohort<T>(rows: readonly T[], spec: MetricSpec<T>): Cohort<T> {
  const raw = rows.map((r) => ({ r, v: spec.value(r), load: spec.perPaper?.(r) ?? 1 }));
  const loads = new Set(raw.map((x) => x.load));
  const normalize = spec.perPaper !== undefined && loads.size > 1;
  const norm = (v: number, load: number) => (normalize ? (load > 0 ? v / load : NaN) : v);
  const vals = raw.flatMap((x) => (x.v === null ? [] : [norm(x.v, x.load)])).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const constant = vals.length >= 2 && vals[0] === vals[vals.length - 1] && vals.length === raw.length;
  if (vals.length < 3 || constant) return { median: vals.length ? quantile(vals, 0.5) : null, q1: null, q3: null, constant, mark: () => null };
  const median = quantile(vals, 0.5);
  const q1 = quantile(vals, 0.25);
  const q3 = quantile(vals, 0.75);
  const gap = Math.max(spec.minGap ?? 0, Math.abs(median) * 0.25);
  const fmt = (v: number) => (normalize ? `${round(v)} per paper` : spec.format ? spec.format(v) : round(v));
  const fmtOwn = (v: number, load: number) => {
    const shown = spec.format ? spec.format(v) : round(v);
    return normalize ? `${shown} ${spec.noun} (${round(norm(v, load))} per paper)` : `${shown} ${spec.noun}`;
  };
  return {
    median,
    q1,
    q3,
    constant: false,
    mark: (row) => {
      const v0 = spec.value(row);
      if (v0 === null) return null;
      const load = spec.perPaper?.(row) ?? 1;
      const v = norm(v0, load);
      if (!Number.isFinite(v)) return null;
      const low = spec.direction === "higher-better" && v < q1 && median - v >= gap && median - v > 0;
      const high = spec.direction === "lower-better" && v > q3 && v - median >= gap && v - median > 0;
      if (!low && !high) return null;
      const where = low ? "below the 25th percentile" : "above the 75th percentile";
      return { side: low ? "low" : "high", text: `${fmtOwn(v0, load)}; ${spec.cohort} median ${fmt(median)}; ${where} of ${spec.cohort}s` };
    },
  };
}

/** Cohorts for several metrics at once, keyed like the spec map. */
export function cohorts<T, K extends string>(rows: readonly T[], specs: Readonly<Record<K, MetricSpec<T>>>): Record<K, Cohort<T>> {
  const out = {} as Record<K, Cohort<T>>;
  for (const k of Object.keys(specs) as K[]) out[k] = cohort(rows, specs[k]);
  return out;
}

/** Append a mark's text to a cell's own tooltip. */
export const withMark = (title: string | undefined, mark: Mark | null): string | undefined =>
  mark ? (title ? `${title}\n${mark.text}` : mark.text) : title;

/**
 * A table cell's content with its mark: a tint, an arrow icon pointing the
 * concerning way, and the numbers in the tooltip (also read out). Muted
 * when the column is constant.
 */
export function Marked({ mark, constant, children, title }: { mark: Mark | null; constant?: boolean; children: ReactNode; title?: string }) {
  if (!mark) return <span className={constant ? "om om-const" : "om"} title={constant ? "same for everyone in this table" : title}>{children}</span>;
  return (
    <span className={`om om-mark om-${mark.side}`} title={withMark(title, mark)} data-testid="outlier-mark" data-side={mark.side}>
      <svg className="om-icon" width="9" height="9" viewBox="0 0 10 10" role="img" aria-label={mark.side === "low" ? `low: ${mark.text}` : `high: ${mark.text}`}>
        {mark.side === "low" ? <path d="M1 2.5h8L5 8.5z" /> : <path d="M1 7.5h8L5 1.5z" />}
      </svg>
      {children}
    </span>
  );
}
