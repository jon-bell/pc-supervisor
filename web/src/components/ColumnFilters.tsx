// Column-header controls for every table (DataTable, MiniTable): the sort
// button (click: ascending → descending → off; shift-click adds a secondary
// key), the filter button and its popover with a widget chosen by the
// column's kind (spec §4 "Tables"), and the chips of active filters above the
// table. Filter edits apply as you go (text and numbers after a short pause)
// and land in the URL (table/useTable.ts).

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { formatDate } from "../format";
import {
  describeFilter,
  facetCounts,
  histogram,
  isActive,
  PRESET_LABELS,
  textSuggestions,
  type DatePreset,
  type Filter,
} from "../table/model";
import { useTableClock, type ColumnSpec, type TableView } from "../table/useTable";
import { ComboList, LiveCount, Marked, useListNav, type ComboOption } from "./listbox";
import { Popover } from "./Popover";

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase();

export function ariaSort<T>(view: TableView<T>, spec: ColumnSpec<T>): "ascending" | "descending" | "none" | undefined {
  if (!spec.kind || !spec.sortable) return undefined;
  const k = view.state.sort.find((s) => s.id === spec.id);
  return k ? (k.desc ? "descending" : "ascending") : "none";
}

/** The header's content: a sort button around the label (when sortable) and a filter button (when filterable). */
export function HeaderControls<T>({ view, spec, children }: { view: TableView<T>; spec: ColumnSpec<T> | undefined; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  if (!spec?.kind) return <span className="dt-htext">{children}</span>;
  const rank = view.state.sort.findIndex((s) => s.id === spec.id);
  const key = rank >= 0 ? view.state.sort[rank]! : null;
  const active = isActive(view.state.filters[spec.id]);
  return (
    <span className="dt-hctl">
      {spec.sortable ? (
        <button
          type="button"
          className={`dt-sort${key ? " dt-sorted" : ""}`}
          data-testid="dt-sort"
          data-col={spec.id}
          title={`Sort by ${spec.label} (shift-click to add as a secondary sort)`}
          onClick={(e) => view.toggleSort(spec.id, e.shiftKey)}
        >
          <span className="dt-htext">{children}</span>
          <span className="dt-sort-ind" aria-hidden="true" data-testid="dt-sort-ind">
            {key ? (key.desc ? "▼" : "▲") : "↕"}
            {key && view.state.sort.length > 1 ? <sub>{rank + 1}</sub> : null}
          </span>
        </button>
      ) : (
        <span className="dt-htext">{children}</span>
      )}
      {spec.filterable ? (
        <>
          <button
            ref={btn}
            type="button"
            className={`dt-filter-btn${active ? " dt-filter-on" : ""}`}
            aria-label={`Filter ${spec.label}${active ? " (filtered)" : ""}`}
            title={`Filter ${spec.label}`}
            aria-haspopup="dialog"
            aria-expanded={open}
            data-testid="dt-filter"
            data-col={spec.id}
            onClick={() => setOpen((o) => !o)}
          >
            <FunnelIcon />
          </button>
          {open ? (
            <Popover anchor={btn} onClose={() => setOpen(false)} label={`Filter ${spec.label}`} testId="dt-filter-popover">
              <FilterPanel view={view} spec={spec} onDone={() => setOpen(false)} focusBack={() => btn.current?.focus()} />
            </Popover>
          ) : null}
        </>
      ) : null}
    </span>
  );
}

function FunnelIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      <path d="M1 2h10L7 6.5V10l-2 1V6.5z" fill="currentColor" />
    </svg>
  );
}

/** The popover body: the kind's widget over a draft, committed to the URL as it changes. */
function FilterPanel<T>({ view, spec, onDone, focusBack }: { view: TableView<T>; spec: ColumnSpec<T>; onDone: () => void; focusBack: () => void }) {
  const committed = view.state.filters[spec.id] ?? null;
  const [draft, setDraft] = useState<Filter | null>(committed);
  const setFilter = useRef(view.setFilter);
  setFilter.current = view.setFilter;
  const pending = useRef<{ f: Filter | null } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const flush = () => {
    clearTimeout(timer.current);
    const p = pending.current;
    pending.current = null;
    if (p) setFilter.current(spec.id, p.f);
  };
  const change = (f: Filter | null, immediate = false) => {
    setDraft(f);
    pending.current = { f };
    clearTimeout(timer.current);
    if (immediate) flush();
    else timer.current = setTimeout(flush, 250);
  };
  // A chip removed (or "clear all") while open resets the draft.
  const committedKey = JSON.stringify(committed);
  useEffect(() => {
    if (!pending.current) setDraft(JSON.parse(committedKey) as Filter | null);
  }, [committedKey]);
  useEffect(() => () => flush(), []);

  const props = { view, spec, draft, change };
  return (
    <div className="fp" data-kind={spec.kind} data-col={spec.id}>
      <div className="fp-title">Filter: {spec.label}</div>
      {spec.kind === "categorical" ? <CategoricalFilter {...props} /> : null}
      {spec.kind === "numeric" ? <NumericFilter {...props} /> : null}
      {spec.kind === "date" ? <DateFilter {...props} /> : null}
      {spec.kind === "text" ? <TextFilter {...props} /> : null}
      {spec.kind === "boolean" ? <BooleanFilter {...props} /> : null}
      <div className="fp-foot">
        <button type="button" className="btn" data-testid="fp-clear" disabled={!isActive(draft ?? undefined)} onClick={() => change(null, true)}>
          Clear
        </button>
        <button
          type="button"
          className="btn btn-primary"
          data-testid="fp-done"
          onClick={() => {
            flush();
            onDone();
            focusBack();
          }}
        >
          Done
        </button>
      </div>
    </div>
  );
}

interface WidgetProps<T> {
  view: TableView<T>;
  spec: ColumnSpec<T>;
  draft: Filter | null;
  change: (f: Filter | null, immediate?: boolean) => void;
}

// ---------------------------------------------------------------- categorical

/** The "has none" option's key (no real value starts with NUL). */
const NONE_KEY = "\u0000none";

function CategoricalFilter<T>({ view, spec, draft, change }: WidgetProps<T>) {
  const values = view.values.get(spec.id) ?? [];
  const show = useMemo(() => spec.format ?? ((s: string) => s), [spec.format]);
  const [typed, setTyped] = useState("");
  const all = useMemo(() => facetCounts(values), [values]);
  const passExcept = view.passExcept;
  const here = useMemo(() => facetCounts(values, passExcept(spec.id)), [values, passExcept, spec.id]);
  const universe = useMemo(() => [...all.counts.keys()].sort((a, b) => collator.compare(show(a), show(b))), [all, show]);
  const hasEmpty = all.empty > 0;
  const cur = draft?.kind === "categorical" ? draft : null;
  const isOn = (v: string) => (cur ? cur.values.includes(v) : true);
  const emptyOn = cur ? cur.empty : true;

  const items = useMemo(() => {
    const needle = fold(typed.trim());
    const xs = universe.filter((v) => !needle || fold(show(v)).includes(needle));
    if (hasEmpty && (!needle || fold("(none)").includes(needle) || fold("empty").includes(needle))) xs.push(NONE_KEY);
    return xs;
  }, [universe, typed, hasEmpty, show]);
  const nav = useListNav(items.length, true, { homeEnd: false, resetOn: typed });

  const set = (values: string[], empty: boolean) => {
    const everything = values.length === universe.length && (empty || !hasEmpty);
    change(everything ? null : { kind: "categorical", values, empty: empty && hasEmpty }, true);
  };
  const toggle = (v: string) => {
    const vs = cur ? [...cur.values] : [...universe];
    const em = cur ? cur.empty : hasEmpty;
    if (v === NONE_KEY) return set(vs, !em);
    set(vs.includes(v) ? vs.filter((x) => x !== v) : universe.filter((x) => x === v || vs.includes(x)), em);
  };
  const only = (v: string) => (v === NONE_KEY ? set([], true) : set([v], false));

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (nav.onNavKey(e)) return;
    if (e.key === "Enter" && nav.activeIndex >= 0) {
      e.preventDefault();
      if (e.altKey) only(items[nav.activeIndex]!);
      else toggle(items[nav.activeIndex]!);
    }
  };

  return (
    <div className="fp-cat">
      <input
        type="search"
        className="fp-search"
        role="combobox"
        aria-expanded="true"
        aria-controls={nav.listId}
        aria-activedescendant={nav.activeIndex >= 0 ? nav.optionId(nav.activeIndex) : undefined}
        aria-label={`Search ${spec.label} values (Enter toggles, Alt+Enter selects only that one)`}
        placeholder="Search values"
        data-autofocus
        data-testid="fp-search"
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        onKeyDown={onKey}
      />
      <div className="fp-row">
        <button type="button" className="btn btn-small" data-testid="fp-all" onClick={() => change(null, true)}>
          Select all
        </button>
        <button type="button" className="btn btn-small" data-testid="fp-none" onClick={() => set([], false)}>
          None
        </button>
      </div>
      <ul id={nav.listId} role="listbox" aria-multiselectable="true" aria-label={`${spec.label} values`} className="fp-list" data-testid="fp-options">
        {items.map((v, i) => {
          const isNone = v === NONE_KEY;
          const on = isNone ? emptyOn : isOn(v);
          const n = isNone ? here.empty : (here.counts.get(v) ?? 0);
          const label = isNone ? "(none)" : show(v);
          return (
            <li
              key={v}
              id={nav.optionId(i)}
              role="option"
              aria-selected={on}
              className={`fp-option${i === nav.activeIndex ? " fp-active" : ""}${n === 0 ? " fp-zero" : ""}`}
              data-testid="fp-option"
              data-value={isNone ? "" : v}
              data-none={isNone ? "1" : undefined}
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => (e.altKey ? only(v) : toggle(v))}
              onMouseMove={() => i !== nav.activeIndex && nav.setActive(i)}
            >
              <span className={`fp-check${on ? " fp-checked" : ""}`} aria-hidden="true" />
              <span className={`fp-label${isNone ? " muted" : ""}`}>
                <Marked text={label} typed={typed.trim()} anywhere />
              </span>
              <span className="combo-count" data-testid="fp-count" title={`${n} row${n === 1 ? "" : "s"} with the other filters applied`}>
                {n}
              </span>
            </li>
          );
        })}
        {items.length === 0 ? <li className="muted fp-empty">No values match.</li> : null}
      </ul>
      <LiveCount n={items.length} noun="value" />
    </div>
  );
}

// ---------------------------------------------------------------- numeric

const round = (n: number) => Math.round(n * 1000) / 1000;

function NumericFilter<T>({ view, spec, draft, change }: WidgetProps<T>) {
  const values = view.values.get(spec.id) ?? [];
  const h = useMemo(() => histogram(values.filter((v): v is number => typeof v === "number")), [values]);
  const cur = draft?.kind === "numeric" ? draft : null;
  const [minText, setMinText] = useState(cur?.min === null || cur?.min === undefined ? "" : String(cur.min));
  const [maxText, setMaxText] = useState(cur?.max === null || cur?.max === undefined ? "" : String(cur.max));
  const lo = h.lo;
  const hi = h.hi;
  const step = h.integer ? 1 : round((hi - lo) / 100) || 1;
  const min = cur?.min ?? null;
  const max = cur?.max ?? null;
  const peak = Math.max(1, ...h.bins.map((b) => b.count));

  const commit = (mn: number | null, mx: number | null, immediate = false) => change(mn === null && mx === null ? null : { kind: "numeric", min: mn, max: mx }, immediate);
  const parse = (s: string): number | null | undefined => (s.trim() === "" ? null : Number.isFinite(Number(s)) ? Number(s) : undefined);
  const inRange = (from: number, to: number) => (min === null || to >= min) && (max === null || from <= max);
  const label = (from: number, to: number) => (h.integer && to - from <= 1 ? `${from}` : `${round(from)}–${round(to)}`);

  if (h.bins.length === 0) return <p className="muted fp-empty">No numbers in this column.</p>;
  return (
    <div className="fp-num">
      <div className="fp-hist" role="group" aria-label={`${spec.label} distribution; click a bar to filter to it`} data-testid="fp-hist">
        {h.bins.map((b, i) => (
          <button
            type="button"
            key={i}
            className={`fp-bar${inRange(b.from, b.to) ? " fp-bar-on" : ""}`}
            title={`${label(b.from, b.to)}: ${b.count}`}
            aria-label={`${label(b.from, b.to)}: ${b.count} rows`}
            tabIndex={-1}
            onClick={() => {
              const mn = round(b.from);
              const mx = h.integer && b.to - b.from <= 1 ? b.from : round(b.to);
              setMinText(String(mn));
              setMaxText(String(mx));
              commit(mn, mx, true);
            }}
          >
            <span style={{ height: `${Math.max(b.count ? 8 : 0, (b.count / peak) * 100)}%` }} />
          </button>
        ))}
      </div>
      <div className="fp-sliders">
        <input
          type="range"
          aria-label={`${spec.label} minimum`}
          min={lo}
          max={hi}
          step={step}
          value={min ?? lo}
          data-testid="fp-min-slider"
          onChange={(e) => {
            const v = Math.min(Number(e.target.value), max ?? hi);
            const mn = v <= lo ? null : v;
            setMinText(mn === null ? "" : String(mn));
            commit(mn, max);
          }}
        />
        <input
          type="range"
          aria-label={`${spec.label} maximum`}
          min={lo}
          max={hi}
          step={step}
          value={max ?? hi}
          data-testid="fp-max-slider"
          onChange={(e) => {
            const v = Math.max(Number(e.target.value), min ?? lo);
            const mx = v >= hi ? null : v;
            setMaxText(mx === null ? "" : String(mx));
            commit(min, mx);
          }}
        />
      </div>
      <div className="fp-row fp-inputs">
        <label>
          Min{" "}
          <input
            type="number"
            inputMode="decimal"
            step="any"
            placeholder={String(round(lo))}
            value={minText}
            data-autofocus
            data-testid="fp-min"
            onChange={(e) => {
              setMinText(e.target.value);
              const v = parse(e.target.value);
              if (v !== undefined) commit(v, max);
            }}
          />
        </label>
        <label>
          Max{" "}
          <input
            type="number"
            inputMode="decimal"
            step="any"
            placeholder={String(round(hi))}
            value={maxText}
            data-testid="fp-max"
            onChange={(e) => {
              setMaxText(e.target.value);
              const v = parse(e.target.value);
              if (v !== undefined) commit(min, v);
            }}
          />
        </label>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- date

function DateFilter<T>({ spec, draft, change }: WidgetProps<T>) {
  const clock = useTableClock();
  const cur = draft?.kind === "date" ? draft : null;
  const presets: { id: DatePreset; label: string }[] = [
    { id: "last24h", label: "Last 24 hours" },
    { id: "last7d", label: "Last 7 days" },
    ...(clock.phaseStart !== null ? [{ id: "phase" as const, label: `Since the phase began (${formatDate(clock.phaseStart, clock.tz)})` }] : []),
  ];
  const setRange = (from: string | null, to: string | null) => change(from || to ? { kind: "date", preset: null, from, to } : null, true);
  return (
    <div className="fp-date">
      <div className="fp-presets" role="group" aria-label="Presets">
        {presets.map((p) => (
          <button
            key={p.id}
            type="button"
            className={`btn btn-small${cur?.preset === p.id ? " btn-on" : ""}`}
            aria-pressed={cur?.preset === p.id}
            data-testid={`fp-preset-${p.id}`}
            title={PRESET_LABELS[p.id]}
            data-autofocus={p.id === "last24h" ? true : undefined}
            onClick={() => change(cur?.preset === p.id ? null : { kind: "date", preset: p.id, from: null, to: null }, true)}
          >
            {p.label}
          </button>
        ))}
      </div>
      <div className="fp-row fp-inputs">
        <label>
          From{" "}
          <input type="date" value={cur?.from ?? ""} data-testid="fp-from" aria-label={`${spec.label} from (inclusive)`} onChange={(e) => setRange(e.target.value || null, cur?.to ?? null)} />
        </label>
        <label>
          To{" "}
          <input type="date" value={cur?.to ?? ""} data-testid="fp-to" aria-label={`${spec.label} to (inclusive)`} onChange={(e) => setRange(cur?.from ?? null, e.target.value || null)} />
        </label>
      </div>
      <p className="muted fp-note">Days in {clock.tz}; “now” is the app&apos;s clock.</p>
    </div>
  );
}

// ---------------------------------------------------------------- text

function TextFilter<T>({ view, spec, draft, change }: WidgetProps<T>) {
  const values = view.values.get(spec.id) ?? [];
  const cur = draft?.kind === "text" ? draft.contains : "";
  const [focused, setFocused] = useState(true);
  const items = useMemo(() => textSuggestions(values, cur), [values, cur]);
  const options = useMemo<ComboOption[]>(() => items.map((s) => ({ key: s.value, label: s.value, count: s.count })), [items]);
  const shown = focused && cur.trim() !== "" && options.length > 0 && !(options.length === 1 && options[0]!.label === cur);
  const nav = useListNav(options.length, shown, { resetOn: cur });
  const set = (s: string, immediate = false) => change(s.trim() ? { kind: "text", contains: s } : null, immediate);
  return (
    <div className="fp-text combo">
      <input
        type="search"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={shown}
        aria-controls={nav.listId}
        aria-activedescendant={shown && nav.activeIndex >= 0 ? nav.optionId(nav.activeIndex) : undefined}
        aria-label={`${spec.label} contains`}
        placeholder="contains…"
        data-autofocus
        data-testid="fp-text"
        value={cur}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onChange={(e) => set(e.target.value)}
        onKeyDown={(e) => {
          if (nav.onNavKey(e)) return;
          if ((e.key === "Enter" || e.key === "Tab") && shown && nav.activeIndex >= 0 && !e.shiftKey) {
            e.preventDefault();
            set(options[nav.activeIndex]!.label, true);
          } else if (e.key === "Enter") {
            e.preventDefault();
            set(cur, true);
          }
        }}
      />
      <ComboList nav={nav} options={options} shown={shown} typed={cur.trim()} label={`${spec.label} suggestions`} testId="fp-suggestions" optionTestId="fp-suggestion" onPick={(o) => set(o.label, true)} />
    </div>
  );
}

// ---------------------------------------------------------------- boolean

function BooleanFilter<T>({ spec, draft, change }: WidgetProps<T>) {
  const cur = draft?.kind === "boolean" ? draft.value : null;
  const name = `fp-bool-${spec.id}`;
  const show = (b: boolean) => (spec.format ? spec.format(String(b)) : b ? "Yes" : "No");
  const opts: [string, boolean | null][] = [
    ["Any", null],
    [show(true), true],
    [show(false), false],
  ];
  return (
    <div className="fp-bool" role="radiogroup" aria-label={spec.label}>
      {opts.map(([label, v], i) => (
        <label key={label} className="fp-radio">
          <input
            type="radio"
            name={name}
            checked={cur === v}
            data-testid={`fp-bool-${v === null ? "any" : String(v)}`}
            data-autofocus={i === 0 ? true : undefined}
            onChange={() => change(v === null ? null : { kind: "boolean", value: v }, true)}
          />{" "}
          {label}
        </label>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- chips

/** Active filters as removable chips, "Clear all", and "N of M". Renders nothing when no filter is on. */
export function FilterChips<T>({ view, noun = "rows" }: { view: TableView<T>; noun?: string }) {
  if (!view.filtering) return null;
  // In column order, so the chips read the same after a reload.
  const entries = view.specs.flatMap((s) => {
    const f = view.state.filters[s.id];
    return isActive(f) ? [[s.id, f] as const] : [];
  });
  return (
    <div className="dt-chips" data-testid="dt-chips" role="group" aria-label="Active column filters">
      {entries.map(([id, f]) => {
        const spec = view.specs.find((s) => s.id === id);
        const text = describeFilter(f, spec?.label ?? id, spec?.format);
        return (
          <span key={id} className="chip chip-info dt-fchip" data-testid="dt-chip" data-col={id}>
            {text}
            <button type="button" className="dt-chip-x" aria-label={`Remove filter: ${text}`} data-testid="dt-chip-remove" onClick={() => view.setFilter(id, null)}>
              ×
            </button>
          </span>
        );
      })}
      <button type="button" className="btn btn-small" data-testid="dt-clear-all" onClick={view.clearFilters}>
        Clear all
      </button>
      <span className="count" data-testid="dt-count" data-shown={view.rows.length} data-total={view.total} aria-live="polite">
        {view.rows.length} of {view.total} {noun}
      </span>
    </div>
  );
}
