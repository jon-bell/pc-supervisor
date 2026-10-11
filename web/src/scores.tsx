// Score encoding (spec §7 "Scores"): every score is a numbered pip coloured
// on a fixed scale for its field, and a paper's merits also show as a dot
// strip on the field's axis, so a 1-and-4 split reads at a glance. The scale
// (values 1..n and the colour scheme) comes from the synced review form
// (/api/meta `scales`); colours follow HotCRP's own scheme mapping
// (src/reviewfield.php Discrete_ReviewField::scheme_value_class), drawn
// from this app's palettes in styles.css (classes sv-<family><step>). The
// number is always shown: colour is never the only channel.

import { createContext, useContext } from "react";
import type { MetaResponse, ScoreScale } from "./api";

export interface Scales {
  merit: ScoreScale | null;
  expertise: ScoreScale | null;
}

export const ScalesContext = createContext<Scales>({ merit: null, expertise: null });
export const useScales = () => useContext(ScalesContext);
export const scalesOf = (meta: MetaResponse | undefined): Scales => meta?.scales ?? { merit: null, expertise: null };

/**
 * HotCRP's schemes: [flags, steps, reverse]. Flag 1 = stored reversed (use
 * the reverse family, flipped); flag 2 = categorical (cycle the steps).
 */
const SCHEMES: Readonly<Record<string, readonly [number, number, string | null]>> = {
  sv: [0, 9, "svr"],
  svr: [1, 9, "sv"],
  bupu: [0, 9, "pubu"],
  pubu: [1, 9, "bupu"],
  rdpk: [1, 9, "pkrd"],
  pkrd: [0, 9, "rdpk"],
  viridisr: [1, 9, "viridis"],
  viridis: [0, 9, "viridisr"],
  orbu: [0, 9, "buor"],
  buor: [1, 9, "orbu"],
  turbo: [0, 9, "turbor"],
  turbor: [1, 9, "turbo"],
  observablex: [2, 10, null],
  catx: [2, 10, null],
  none: [2, 1, null],
};
const ALIASES: Readonly<Record<string, string>> = { publ: "pubu", blpu: "bupu" };

/** Families this app has palettes for; the rest fall back to "sv" (documented in spec §7). */
const PALETTES: ReadonlySet<string> = new Set(["sv", "bupu", "viridis", "orbu", "none"]);

/** The colour class of value `v` on an n-value field with HotCRP scheme `scheme` ("sv-sv3"); "" for no value. */
export function scoreClass(v: number | null, n: number, scheme = "sv"): string {
  if (v === null || v < 0.8) return "";
  const name = SCHEMES[scheme] ? scheme : (ALIASES[scheme] ?? "sv");
  const [flags, steps, rev] = SCHEMES[name]!;
  const family = (flags & 1) !== 0 ? rev! : name;
  const flip = (flags & 1) !== 0;
  let x: number;
  if (n <= 1) x = flip ? 1 : steps;
  else {
    const fv = flip ? n + 1 - v : v;
    x = (flags & 2) !== 0 ? (Math.round(fv - 1) % steps) + 1 : Math.round(((fv - 1) * (steps - 1)) / (n - 1)) + 1;
  }
  if (family === "none") return "sv-none";
  if (!PALETTES.has(family)) return `sv-sv${Math.round(((x - 1) * 8) / Math.max(1, steps - 1)) + 1}`;
  return `sv-${family}${Math.min(Math.max(x, 1), 9)}`;
}

/** Values run 1..n: the form's label count, else the largest value seen (at least 2). */
export function scaleSize(scale: ScoreScale | null, seen: readonly (number | null)[] = []): number {
  if (scale && scale.labels.length > 0) return scale.labels.length;
  return Math.max(2, ...seen.map((v) => v ?? 0));
}

/** "4 (Accept)" when the form names the value. */
export function scoreLabel(scale: ScoreScale | null, v: number | null): string {
  if (v === null) return "none";
  const name = scale?.labels[v - 1];
  return name ? `${v} (${name})` : String(v);
}

/** One score as a numbered pip. `exp` adds the reviewer's expertise as a small figure. */
export function Pip({ v, field = "merit", exp, title }: { v: number | null; field?: "merit" | "expertise"; exp?: number | null; title?: string }) {
  const scales = useScales();
  const scale = scales[field];
  const n = scaleSize(scale, [v]);
  const cls = field === "expertise" ? "pip-exp" : scoreClass(v, n, scale?.scheme);
  return (
    <span className={`pip ${cls}`} data-exp={exp ?? undefined} title={title}>
      {v ?? "–"}
    </span>
  );
}

export interface ScoreItem {
  merit: number | null;
  expertise?: number | null;
  label?: string;
}

/**
 * A paper's merits: pips in review order (separated by visually hidden "/",
 * so the cell's text is "2/4/4"), hollow pips for reviews not yet in, then
 * the dot strip. The caller adds its own trailing text.
 */
export function ScorePips({ items, missing = 0 }: { items: readonly ScoreItem[]; missing?: number }) {
  const scales = useScales();
  const n = scaleSize(scales.merit, items.map((i) => i.merit));
  const ms = scales.expertise ? scales.expertise.labels.length : null;
  return (
    <span className="pips">
      {items.map((it, i) => (
        <span key={i} className="pip-wrap">
          {i > 0 ? <span className="visually-hidden">/</span> : null}
          <span
            className={`pip ${scoreClass(it.merit, n, scales.merit?.scheme)}${(it.expertise ?? null) !== null ? " pip-has-exp" : ""}`}
            data-exp={it.expertise ?? undefined}
            title={`${it.label ? `${it.label}: ` : ""}merit ${scoreLabel(scales.merit, it.merit)}${
              (it.expertise ?? null) !== null ? `, expertise ${scoreLabel(scales.expertise, it.expertise ?? null)}${ms ? ` of ${ms}` : ""}` : ""
            }`}
          >
            {it.merit ?? "–"}
          </span>
        </span>
      ))}
      {Array.from({ length: Math.max(0, missing) }, (_, i) => (
        <span key={`m${i}`} className="pip pip-missing" aria-hidden="true" title="review not submitted yet" />
      ))}
    </span>
  );
}

/**
 * The merits on the field's axis (1..n): a tick per value, a dot per score
 * (stacked when equal), and the range between lowest and highest drawn as
 * a bar, so a wide split is a long bar.
 */
export function ScoreStrip({ values, width = 60 }: { values: readonly number[]; width?: number }) {
  const scales = useScales();
  const n = scaleSize(scales.merit, values);
  const h = 18;
  const pad = 5;
  const X = (v: number) => pad + ((v - 1) / Math.max(1, n - 1)) * (width - 2 * pad);
  const base = h - 5;
  const seen = new Map<number, number>();
  const min = values.length ? Math.min(...values) : null;
  const max = values.length ? Math.max(...values) : null;
  return (
    <svg className="strip" width={width} height={h} viewBox={`0 0 ${width} ${h}`} aria-hidden="true">
      <line x1={pad} x2={width - pad} y1={base} y2={base} className="strip-axis" />
      {Array.from({ length: n }, (_, i) => (
        <line key={i} x1={X(i + 1)} x2={X(i + 1)} y1={base - 2} y2={base + 2} className="strip-tick" />
      ))}
      {min !== null && max !== null && max > min ? <line x1={X(min)} x2={X(max)} y1={base} y2={base} className="strip-range" /> : null}
      {values.map((v, i) => {
        const k = seen.get(v) ?? 0;
        seen.set(v, k + 1);
        return <circle key={i} cx={X(v)} cy={base - k * 5} r={3.5} className={`strip-dot ${scoreClass(v, n, scales.merit?.scheme)}`} />;
      })}
    </svg>
  );
}

/** Pips plus strip with an optional " (2/3)" for missing reviews: the triage/lead/person merit cell. */
export function MeritCell({
  items,
  submitted,
  assigned,
  testId,
  strip = true,
}: {
  items: readonly ScoreItem[];
  submitted?: number;
  assigned?: number;
  testId?: string;
  strip?: boolean;
}) {
  const merits = items.flatMap((i) => (i.merit === null ? [] : [i.merit]));
  const short = submitted !== undefined && assigned !== undefined && submitted < assigned;
  return (
    <span className="scores" data-testid={testId} title={submitted !== undefined && assigned !== undefined ? `${submitted} of ${assigned} reviews submitted` : undefined}>
      {items.length === 0 && !short ? <span className="muted">–</span> : <ScorePips items={items} missing={short ? assigned! - submitted! : 0} />}
      {short ? (
        <span className="muted rv-count">
          {" "}
          ({submitted}/{assigned})
        </span>
      ) : null}
      {strip && merits.length > 1 ? <ScoreStrip values={merits} /> : null}
    </span>
  );
}
