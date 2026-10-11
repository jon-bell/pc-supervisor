// Small inline-SVG charts, no chart library (a sparkline, a load bar, a
// histogram and a line chart need ~200 lines; a library would be the
// biggest dependency in the bundle). Colors come from CSS variables in
// styles.css. Hover: every mark has a <title> (native tooltip) with its value,
// and each chart's numbers are also shown as text next to it.

import { formatDate, plural } from "../format";

/** Comments per day as tiny columns; a day with none is a baseline tick. */
export function Sparkline({ daily, start, tz, testId }: { daily: readonly number[]; start: number; tz: string; testId?: string }) {
  const w = 120;
  const h = 22;
  const n = Math.max(daily.length, 1);
  const step = w / n;
  const bw = Math.max(1, step - 1);
  const max = Math.max(1, ...daily);
  const total = daily.reduce((a, b) => a + b, 0);
  return (
    <svg
      className="spark"
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      role="img"
      aria-label={`${plural(total, "comment")} over ${plural(daily.length, "day")}`}
      data-testid={testId}
      data-total={total}
    >
      <line x1={0} x2={w} y1={h - 0.5} y2={h - 0.5} className="spark-base" />
      {daily.map((v, i) => {
        const bh = v === 0 ? 0 : Math.max(3, ((h - 2) * v) / max);
        return (
          <rect key={i} x={i * step} y={h - 1 - bh} width={bw} height={bh} rx={bh > 3 ? 1 : 0} className="spark-bar">
            <title>{`${formatDate(start + i * 86_400_000, tz)}: ${plural(v, "comment")}`}</title>
          </rect>
        );
      })}
    </svg>
  );
}

/** Load (bar length, relative to the largest load) with the flagged share filled. */
export function LoadBar({ load, flagged, max }: { load: number; flagged: number; max: number }) {
  const w = 96;
  const h = 8;
  const lw = max > 0 ? Math.max(2, (w * load) / max) : 0;
  const fw = load > 0 ? (lw * flagged) / load : 0;
  return (
    <svg className="loadbar" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      <rect x={0} y={0} width={lw} height={h} rx={2} className="load-total" />
      {fw > 0 ? <rect x={0} y={0} width={fw} height={h} rx={2} className="load-flagged" /> : null}
    </svg>
  );
}

export interface Bin {
  label: string;
  value: number;
  highlight?: boolean;
  title: string;
}

/** Vertical bars with the count above each and the label below. */
export function Histogram({ bins, testId, ariaLabel }: { bins: readonly Bin[]; testId?: string; ariaLabel: string }) {
  const bw = 44;
  const gap = 12;
  const top = 18;
  const plotH = 120;
  const w = bins.length * (bw + gap) + gap;
  const h = top + plotH + 22;
  const max = Math.max(1, ...bins.map((b) => b.value));
  return (
    <svg className="chart" width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={ariaLabel} data-testid={testId}>
      <line x1={0} x2={w} y1={top + plotH + 0.5} y2={top + plotH + 0.5} className="axis" />
      {bins.map((b, i) => {
        const x = gap + i * (bw + gap);
        const bh = b.value === 0 ? 0 : Math.max(2, (plotH * b.value) / max);
        return (
          <g key={b.label} data-testid="bin" data-label={b.label} data-value={b.value}>
            <title>{b.title}</title>
            {bh > 0 ? <rect x={x} y={top + plotH - bh} width={bw} height={bh} rx={3} className={b.highlight ? "bar bar-hl" : "bar"} /> : null}
            <text x={x + bw / 2} y={top + plotH - bh - 4} textAnchor="middle" className="val">
              {b.value}
            </text>
            <text x={x + bw / 2} y={top + plotH + 15} textAnchor="middle" className="tick">
              {b.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/** Push end labels apart so none sit within 13px of another (keeps input order). */
function endLabelYs(ys: readonly number[]): number[] {
  const order = ys.map((y, i) => ({ y, i })).sort((a, b) => a.y - b.y);
  for (let k = 1; k < order.length; k++) {
    if (order[k]!.y - order[k - 1]!.y < 13) order[k]!.y = order[k - 1]!.y + 13;
  }
  const out = [...ys];
  for (const o of order) out[o.i] = o.y;
  return out;
}

export interface Series {
  key: string;
  label: string;
  className: string;
  values: readonly number[];
}

export interface Marker {
  at: number;
  label: string;
  className?: string;
}

/**
 * A line chart over time with labelled vertical markers (phase dates). One
 * y-axis (paper counts). The x domain covers the points and every marker.
 */
export function TimeLines({
  ts,
  series,
  markers,
  tz,
  testId,
  ariaLabel,
}: {
  ts: readonly number[];
  series: readonly Series[];
  markers: readonly Marker[];
  tz: string;
  testId?: string;
  ariaLabel: string;
}) {
  const w = 760;
  const m = { l: 36, r: 110, t: 0, b: 24 };
  const pw = w - m.l - m.r;
  const xs = [...ts, ...markers.map((k) => k.at)];
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs, x0 + 1);
  const ymax = Math.max(1, ...series.flatMap((s) => s.values));
  const X = (t: number) => m.l + ((t - x0) / (x1 - x0)) * pw;
  const yTicks = [...new Set([0, Math.round(ymax / 2), ymax])];
  // Marker labels sit in a band above the plot, one row each where needed so
  // no two overlap (row 0 nearest the plot). The vertical lines stay inside
  // the plot, so they never cross a label; each label starts (or, near the
  // right edge, ends) at its line's x, with a short tick there.
  const sorted = [...markers].sort((a, b) => a.at - b.at);
  const placed: { a: number; b: number; row: number }[] = [];
  const CH = 6.4; // average glyph width at 11px
  const labels = sorted.map((mk) => {
    const x = X(mk.at);
    const text = `${mk.label} · ${formatDate(mk.at, tz)}`;
    const width = text.length * CH;
    const end = x + 3 + width > w - 2;
    const a = end ? x - 3 - width : x - 1;
    const b = end ? x + 1 : x + 3 + width;
    let row = 0;
    while (placed.some((p) => p.row === row && !(b + 6 < p.a || a > p.b + 6))) row++;
    placed.push({ a, b, row });
    return { mk, x, text, end, row };
  });
  const rows = Math.max(1, ...labels.map((l) => l.row + 1));
  m.t = 8 + rows * 13;
  const h = m.t + 200 + m.b;
  const ph = h - m.t - m.b;
  const Y = (v: number) => m.t + ph - (v / ymax) * ph;
  const last = ts.length - 1;
  return (
    <svg className="chart chart-wide" viewBox={`0 0 ${w} ${h}`} role="img" aria-label={ariaLabel} data-testid={testId}>
      {yTicks.map((v) => (
        <g key={v}>
          <line x1={m.l} x2={m.l + pw} y1={Y(v)} y2={Y(v)} className="grid" />
          <text x={m.l - 6} y={Y(v) + 4} textAnchor="end" className="tick">
            {v}
          </text>
        </g>
      ))}
      {labels.map(({ mk, x, text, end, row }) => {
        const ly = m.t - 6 - row * 13;
        return (
          <g key={`${mk.label}-${mk.at}`} className={mk.className ?? "marker"} data-testid="marker" data-label={mk.label}>
            <line x1={x} x2={x} y1={m.t} y2={m.t + ph} />
            <line x1={x} x2={x} y1={ly - 8} y2={ly + 2} className="marker-tick" />
            <text x={end ? x - 3 : x + 3} y={ly} textAnchor={end ? "end" : "start"} className="marker-label">
              {text}
            </text>
          </g>
        );
      })}
      {series.map((s) => (
        <polyline
          key={s.key}
          className={`line ${s.className}`}
          fill="none"
          points={s.values.map((v, i) => `${X(ts[i]!).toFixed(1)},${Y(v).toFixed(1)}`).join(" ")}
          data-testid={`line-${s.key}`}
        />
      ))}
      {/* Direct labels at the line ends. */}
      {last >= 0
        ? endLabelYs(series.map((s) => Y(s.values[last]!) + 4)).map((y, k) => {
            const s = series[k]!;
            return (
              <text key={s.key} x={X(ts[last]!) + 6} y={y} className="end-label" data-testid={`end-${s.key}`}>
                {s.values[last]} {s.label}
              </text>
            );
          })
        : null}
      {/* Hover targets: one column per point. */}
      {ts.map((t, i) => {
        const left = i === 0 ? m.l : (X(ts[i - 1]!) + X(t)) / 2;
        const right = i === last ? X(t) + 4 : (X(t) + X(ts[i + 1]!)) / 2;
        return (
          <rect key={t} x={left} y={m.t} width={Math.max(1, right - left)} height={ph} className="hover-col">
            <title>{`${formatDate(t, tz)}: ${series.map((s) => `${s.values[i]} ${s.label}`).join(", ")}`}</title>
          </rect>
        );
      })}
      <line x1={m.l} x2={m.l + pw} y1={m.t + ph + 0.5} y2={m.t + ph + 0.5} className="axis" />
    </svg>
  );
}
