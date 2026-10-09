// Column sort and filter for every table (DataTable, MiniTable): the pure
// part. Comparators, filter predicates, facet counts and histogram bins, the
// URL encoding of a table's state, and conference-time-zone dates. No React,
// no DOM, and no wall clock: "now" is always passed in (the server's, which
// honours PCS_NOW), so a pinned clock filters the same everywhere.

export type ColumnKind = "categorical" | "numeric" | "date" | "text" | "boolean";

/** A cell's value for sorting and filtering. Arrays are multi-valued categorical cells (ACs, rules, tags). */
export type CellValue = string | number | boolean | null | undefined | readonly string[];

/** What a comparator sees: one scalar per cell, null = empty (always sorted last). */
export type Sortable = string | number | boolean | null;

export interface SortKey {
  id: string;
  desc: boolean;
}

export type DatePreset = "last24h" | "last7d" | "phase";

export type Filter =
  | { kind: "categorical"; values: readonly string[]; empty: boolean }
  | { kind: "numeric"; min: number | null; max: number | null }
  | { kind: "date"; preset: DatePreset | null; from: string | null; to: string | null }
  | { kind: "text"; contains: string }
  | { kind: "boolean"; value: boolean };

export interface TableState {
  sort: readonly SortKey[];
  filters: Readonly<Record<string, Filter>>;
}

export const EMPTY_STATE: TableState = { sort: [], filters: {} };

/** The clock a date filter resolves against: the server's now, the conference zone, and when the current phase began. */
export interface FilterClock {
  now: number;
  tz: string;
  phaseStart: number | null;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// ---------------------------------------------------------------- values

/** A cell's distinct categorical values; [] when empty (null, "", []). */
export function categories(v: CellValue): readonly string[] {
  if (v === null || v === undefined || v === "") return [];
  if (Array.isArray(v)) return v as readonly string[];
  return [String(v)];
}

const isEmpty = (v: CellValue) => v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);

/** The scalar a cell sorts by. Multi-valued cells sort by their labels, joined. */
export function sortable(v: CellValue, label?: (s: string) => string): Sortable {
  if (isEmpty(v)) return null;
  if (Array.isArray(v)) return (v as readonly string[]).map((s) => (label ? label(s) : s)).join(", ");
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && label) return label(v);
  return v as string | boolean;
}

/** Mean of a list (merits), null when empty. */
export const mean = (xs: readonly number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

// ---------------------------------------------------------------- sorting

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const TYPE_ORDER = { boolean: 0, number: 1, string: 2 } as const;

/** Type-aware compare of two non-null values: numbers (and dates, as ms) numerically, strings with locale + numeric collation, false before true. */
export function compareValues(a: string | number | boolean, b: string | number | boolean): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "string" && typeof b === "string") return collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  return TYPE_ORDER[typeof a as keyof typeof TYPE_ORDER] - TYPE_ORDER[typeof b as keyof typeof TYPE_ORDER];
}

/**
 * Row indices in sort order: each key in turn, nulls last in either
 * direction, and ties in their original order (stable), so with no keys the
 * caller's (server's) order is kept.
 */
export function sortIndices(indices: readonly number[], keys: readonly { values: readonly Sortable[]; desc: boolean }[]): number[] {
  const out = [...indices];
  if (keys.length === 0) return out;
  out.sort((i, j) => {
    for (const k of keys) {
      const a = k.values[i] ?? null;
      const b = k.values[j] ?? null;
      if (a === null || b === null) {
        if (a === b) continue;
        return a === null ? 1 : -1;
      }
      const c = compareValues(a, b);
      if (c !== 0) return k.desc ? -c : c;
    }
    return i - j;
  });
  return out;
}

/**
 * The sort after a header click: ascending, then descending, then off. A
 * plain click makes this column the only key; shift-click adds it as the next
 * key (or cycles it in place).
 */
export function nextSort(sort: readonly SortKey[], id: string, multi: boolean): SortKey[] {
  if (!multi) {
    const cur = sort.length === 1 && sort[0]!.id === id ? sort[0]! : undefined;
    if (!cur) return [{ id, desc: false }];
    return cur.desc ? [] : [{ id, desc: true }];
  }
  const i = sort.findIndex((k) => k.id === id);
  if (i < 0) return [...sort, { id, desc: false }];
  if (!sort[i]!.desc) return sort.map((k, j) => (j === i ? { id, desc: true } : k));
  return sort.filter((_, j) => j !== i);
}

// ---------------------------------------------------------------- filters

const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase();

/** Whether a filter does anything (an empty text box or an open range does not). */
export function isActive(f: Filter | undefined): f is Filter {
  if (!f) return false;
  switch (f.kind) {
    case "categorical":
    case "boolean":
      return true;
    case "numeric":
      return f.min !== null || f.max !== null;
    case "date":
      return f.preset !== null || f.from !== null || f.to !== null;
    case "text":
      return f.contains.trim() !== "";
  }
}

/** [from, to) in ms for a date filter, against the given clock. */
export function dateRange(f: Extract<Filter, { kind: "date" }>, clock: FilterClock): { from: number | null; to: number | null } {
  switch (f.preset) {
    case "last24h":
      return { from: clock.now - DAY, to: clock.now + 1 };
    case "last7d":
      return { from: clock.now - 7 * DAY, to: clock.now + 1 };
    case "phase":
      return { from: clock.phaseStart, to: clock.now + 1 };
    default:
      return {
        from: f.from ? zonedDayStart(f.from, clock.tz) : null,
        to: f.to ? zonedDayStart(addDays(f.to, 1), clock.tz) : null,
      };
  }
}

/** A predicate over cell values for one filter. */
export function compileFilter(f: Filter, clock: FilterClock): (v: CellValue) => boolean {
  switch (f.kind) {
    case "categorical": {
      const set = new Set(f.values);
      return (v) => {
        const cs = categories(v);
        return cs.length === 0 ? f.empty : cs.some((c) => set.has(c));
      };
    }
    case "numeric":
      return (v) => typeof v === "number" && Number.isFinite(v) && (f.min === null || v >= f.min) && (f.max === null || v <= f.max);
    case "date": {
      const { from, to } = dateRange(f, clock);
      return (v) => typeof v === "number" && Number.isFinite(v) && (from === null || v >= from) && (to === null || v < to);
    }
    case "text": {
      const needle = fold(f.contains.trim());
      return (v) => (typeof v === "string" ? [v] : Array.isArray(v) ? (v as readonly string[]) : v === null || v === undefined ? [] : [String(v)]).some((s) => fold(s).includes(needle));
    }
    case "boolean":
      return (v) => v === f.value;
  }
}

/** Per value: how many rows carry it (multi-valued cells count once per value), plus rows with none. */
export function facetCounts(values: readonly CellValue[], include?: (i: number) => boolean): { counts: Map<string, number>; empty: number } {
  const counts = new Map<string, number>();
  let empty = 0;
  values.forEach((v, i) => {
    if (include && !include(i)) return;
    const cs = categories(v);
    if (cs.length === 0) empty++;
    for (const c of new Set(cs)) counts.set(c, (counts.get(c) ?? 0) + 1);
  });
  return { counts, empty };
}

export interface Bin {
  from: number;
  to: number;
  count: number;
}

/** Histogram bins over [lo, hi]: one per integer when the values are small integers, else `max` equal bins. */
export function histogram(values: readonly number[], max = 20): { lo: number; hi: number; integer: boolean; bins: Bin[] } {
  const xs = values.filter((v) => Number.isFinite(v));
  if (xs.length === 0) return { lo: 0, hi: 0, integer: true, bins: [] };
  let lo = Infinity;
  let hi = -Infinity;
  for (const x of xs) {
    if (x < lo) lo = x;
    if (x > hi) hi = x;
  }
  const integer = xs.every((x) => Number.isInteger(x));
  const n = integer && hi - lo + 1 <= max ? hi - lo + 1 : lo === hi ? 1 : max;
  const width = integer && n === hi - lo + 1 ? 1 : (hi - lo) / n || 1;
  const bins: Bin[] = Array.from({ length: n }, (_, i) => ({ from: lo + i * width, to: lo + (i + 1) * width, count: 0 }));
  for (const x of xs) bins[Math.min(n - 1, Math.floor((x - lo) / width))]!.count++;
  return { lo, hi, integer, bins };
}

/** Distinct text values containing `typed` (accent- and case-insensitive), most frequent first. */
export function textSuggestions(values: readonly CellValue[], typed: string, limit = 8): { value: string; count: number }[] {
  const needle = fold(typed.trim());
  const counts = new Map<string, number>();
  for (const v of values) {
    for (const s of typeof v === "string" ? [v] : Array.isArray(v) ? (v as readonly string[]) : []) {
      if (s && (!needle || fold(s).includes(needle))) counts.set(s, (counts.get(s) ?? 0) + 1);
    }
  }
  return [...counts]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => {
      // Prefix matches first, then by frequency, then alphabetically.
      const pa = fold(a.value).startsWith(needle) ? 0 : 1;
      const pb = fold(b.value).startsWith(needle) ? 0 : 1;
      return pa - pb || b.count - a.count || collator.compare(a.value, b.value);
    })
    .slice(0, limit);
}

// ---------------------------------------------------------------- chip text

const fmtNum = (n: number) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100));

export const PRESET_LABELS: Readonly<Record<DatePreset, string>> = {
  last24h: "last 24 hours",
  last7d: "last 7 days",
  phase: "since the phase began",
};

/** "AC: Ada, Ben", "Severity 2–5", "Title contains “x”": the chip above the table. */
export function describeFilter(f: Filter, label: string, format?: (v: string) => string): string {
  const show = format ?? ((s: string) => s);
  switch (f.kind) {
    case "categorical": {
      const names = [...f.values.map(show), ...(f.empty ? ["(none)"] : [])];
      if (names.length === 0) return `${label}: nothing selected`;
      return `${label}: ${names.length > 3 ? `${names.slice(0, 2).join(", ")} +${names.length - 2} more` : names.join(", ")}`;
    }
    case "numeric":
      if (f.min !== null && f.max !== null) return f.min === f.max ? `${label} = ${fmtNum(f.min)}` : `${label} ${fmtNum(f.min)}–${fmtNum(f.max)}`;
      return f.min !== null ? `${label} ≥ ${fmtNum(f.min)}` : `${label} ≤ ${fmtNum(f.max ?? 0)}`;
    case "date":
      if (f.preset) return `${label}: ${PRESET_LABELS[f.preset]}`;
      if (f.from && f.to) return `${label}: ${f.from} to ${f.to}`;
      return f.from ? `${label}: from ${f.from}` : `${label}: until ${f.to}`;
    case "text":
      return `${label} contains “${f.contains.trim()}”`;
    case "boolean":
      return `${label}: ${format ? format(String(f.value)) : f.value ? "yes" : "no"}`;
  }
}

// ---------------------------------------------------------------- URL state
//
// Each table owns the query parameters under its key: `<key>.sort=a,-b`
// (comma-separated, "-" = descending) and one `<key>.<column>` per filtered
// column. Values:
//   categorical  repeated params, one per selected value; `~none` is the
//                "has none" option, `~nothing` an empty selection, and a value
//                starting with "~" is written with "~~"
//   numeric      `min..max`, either side optional (`2..`, `..5`)
//   date         `last24h`, `last7d`, `phase`, or `YYYY-MM-DD..YYYY-MM-DD`
//                (either side optional; days in the conference time zone)
//   text         the text
//   boolean      `yes` or `no`
// Unknown columns and malformed values are ignored, so an old link degrades
// to fewer filters, never an error.

export const TABLE_KEY = /^[a-z][a-z0-9-]*$/;
/** Whether a query parameter belongs to some table's state (router.tsx keeps them sticky). */
export const isTableParam = (name: string) => /^[a-z][a-z0-9-]*\.[A-Za-z0-9_-]+$/.test(name);

const NONE = "~none";
const NOTHING = "~nothing";
const escapeCat = (v: string) => (v.startsWith("~") ? `~${v}` : v);
const unescapeCat = (v: string) => (v.startsWith("~~") ? v.slice(1) : v);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseNumber(s: string): number | null | undefined {
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

export function encodeFilter(f: Filter): string[] {
  switch (f.kind) {
    case "categorical": {
      const out = f.values.map(escapeCat);
      if (f.empty) out.push(NONE);
      return out.length ? out : [NOTHING];
    }
    case "numeric":
      return [`${f.min ?? ""}..${f.max ?? ""}`];
    case "date":
      return [f.preset ?? `${f.from ?? ""}..${f.to ?? ""}`];
    case "text":
      return [f.contains];
    case "boolean":
      return [f.value ? "yes" : "no"];
  }
}

export function decodeFilter(kind: ColumnKind, raw: readonly string[]): Filter | null {
  if (raw.length === 0) return null;
  const one = raw[0]!;
  switch (kind) {
    case "categorical": {
      if (raw.length === 1 && one === NOTHING) return { kind, values: [], empty: false };
      const values = [...new Set(raw.filter((v) => v !== NONE && v !== NOTHING && v !== "").map(unescapeCat))];
      const empty = raw.includes(NONE);
      return values.length || empty ? { kind, values, empty } : null;
    }
    case "numeric": {
      const at = one.indexOf("..");
      if (at < 0) return null;
      const min = parseNumber(one.slice(0, at));
      const max = parseNumber(one.slice(at + 2));
      if (min === undefined || max === undefined || (min === null && max === null)) return null;
      return { kind, min, max };
    }
    case "date": {
      if (one === "last24h" || one === "last7d" || one === "phase") return { kind, preset: one, from: null, to: null };
      const at = one.indexOf("..");
      if (at < 0) return null;
      const from = one.slice(0, at) || null;
      const to = one.slice(at + 2) || null;
      if ((from && !DAY_RE.test(from)) || (to && !DAY_RE.test(to)) || (!from && !to)) return null;
      return { kind, preset: null, from, to };
    }
    case "text":
      return one.trim() ? { kind, contains: one } : null;
    case "boolean":
      return one === "yes" ? { kind, value: true } : one === "no" ? { kind, value: false } : null;
  }
}

/** A table's state from the query string; `kinds` are its filterable columns, `sortable` its sortable ones. */
export function parseTableState(q: URLSearchParams, key: string, kinds: Readonly<Record<string, ColumnKind>>, sortableIds: readonly string[] = Object.keys(kinds)): TableState {
  const sort: SortKey[] = [];
  for (const part of (q.get(`${key}.sort`) ?? "").split(",")) {
    const desc = part.startsWith("-");
    const id = desc ? part.slice(1) : part;
    if (id && sortableIds.includes(id) && !sort.some((k) => k.id === id)) sort.push({ id, desc });
  }
  const filters: Record<string, Filter> = {};
  for (const [id, kind] of Object.entries(kinds)) {
    const f = decodeFilter(kind, q.getAll(`${key}.${id}`));
    if (f && isActive(f)) filters[id] = f;
  }
  return { sort, filters };
}

/** A copy of `q` with this table's parameters replaced by `state` (other parameters, e.g. search and t, untouched). */
export function writeTableState(q: URLSearchParams, key: string, state: TableState): URLSearchParams {
  const out = new URLSearchParams();
  for (const [k, v] of q) if (!k.startsWith(`${key}.`)) out.append(k, v);
  if (state.sort.length) out.set(`${key}.sort`, state.sort.map((k) => `${k.desc ? "-" : ""}${k.id}`).join(","));
  for (const [id, f] of Object.entries(state.filters)) {
    if (!isActive(f)) continue;
    for (const v of encodeFilter(f)) out.append(`${key}.${id}`, v);
  }
  return out;
}

/** The part of a query string that belongs to one table (a cheap memo key). */
export function tableParamsKey(q: URLSearchParams, key: string): string {
  const parts: string[] = [];
  for (const [k, v] of q) if (k.startsWith(`${key}.`)) parts.push(`${k}=${v}`);
  return parts.join("&");
}

// ---------------------------------------------------------------- dates in the conference zone

/** The zone's UTC offset (ms) at an instant. */
function zoneOffset(ms: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(ms);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** Midnight at the start of `YYYY-MM-DD` in `tz`, as ms. */
export function zonedDayStart(day: string, tz: string): number {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d);
  let t = guess - zoneOffset(guess, tz);
  // Across a DST change the offset at the answer can differ from the guess's.
  const again = guess - zoneOffset(t, tz);
  if (again !== t) t = again;
  return t;
}

/** `YYYY-MM-DD` of an instant in `tz`. */
export function zonedDay(ms: number, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
}

export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const t = Date.UTC(y, m - 1, d + n);
  const iso = new Date(t).toISOString();
  return iso.slice(0, 10);
}

/** When the current phase began: the latest phase boundary at or before now. */
export function phaseStartOf(phases: Readonly<Record<string, number | null>>, now: number): number | null {
  let best: number | null = null;
  for (const t of Object.values(phases)) if (t !== null && t <= now && (best === null || t > best)) best = t;
  return best;
}
