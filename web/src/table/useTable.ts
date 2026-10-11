// The React side of column sort and filter: a table's state lives in the URL
// query under its key (model.ts documents the encoding), so it survives
// navigation, reloads and shared links and composes with ?search= and ?t=.
// useTableView turns (data, columns, state) into the visible rows, memoized
// so typing in a filter or re-rendering a parent never re-sorts 2,400 rows
// needlessly.

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { navigate, useLocation } from "../router";
import {
  compileFilter,
  EMPTY_STATE,
  isActive,
  nextSort,
  parseTableState,
  sortable,
  sortIndices,
  tableParamsKey,
  TABLE_KEY,
  writeTableState,
  type CellValue,
  type ColumnKind,
  type Filter,
  type FilterClock,
  type TableState,
} from "./model";

/** The server's clock (GET /api/meta): date filters resolve against it, never the browser's. App.tsx provides it. */
export const TableClockContext = createContext<FilterClock>({ now: 0, tz: "UTC", phaseStart: null });
export const useTableClock = () => useContext(TableClockContext);

export interface ColumnSpec<T> {
  id: string;
  /** Plain-text header, for chips and labels. */
  label: string;
  kind: ColumnKind | null;
  value: (row: T) => CellValue;
  /** Display label for a categorical value (or "true"/"false" for a boolean). */
  format?: (v: string) => string;
  sortable: boolean;
  filterable: boolean;
}

function useUrlState(key: string | undefined, kinds: Readonly<Record<string, ColumnKind>>, sortableIds: readonly string[]): [TableState, (s: TableState) => void] {
  if (key !== undefined && !TABLE_KEY.test(key)) throw new Error(`bad table key ${key}`);
  const loc = useLocation();
  const raw = key === undefined ? "" : tableParamsKey(loc.query, key);
  const kindsKey = JSON.stringify(kinds);
  const sortKey = sortableIds.join(",");
  const [local, setLocal] = useState<TableState>(EMPTY_STATE);
  const fromUrl = useMemo(
    () => (key === undefined ? EMPTY_STATE : parseTableState(new URLSearchParams(raw), key, JSON.parse(kindsKey) as Record<string, ColumnKind>, sortKey ? sortKey.split(",") : [])),
    [key, raw, kindsKey, sortKey],
  );
  const set = useCallback(
    (s: TableState) => {
      if (key === undefined) return setLocal(s);
      const q = writeTableState(new URLSearchParams(window.location.search), key, s);
      const qs = q.toString();
      // replace: a filter tweak is not a history entry of its own; sticky: false,
      // since q already carries every other parameter (and must lose removed ones).
      navigate(`${window.location.pathname}${qs ? `?${qs}` : ""}`, { replace: true, sticky: false });
    },
    [key],
  );
  return key === undefined ? [local, setLocal] : [fromUrl, set];
}

export interface TableView<T> {
  rows: T[];
  total: number;
  state: TableState;
  specs: readonly ColumnSpec<T>[];
  /** Each column's cell values, in data order. */
  values: ReadonlyMap<string, readonly CellValue[]>;
  data: readonly T[];
  /** Whether data row i passes every active filter except column `id`'s (facet counts). */
  passExcept: (id: string) => (i: number) => boolean;
  toggleSort: (id: string, multi: boolean) => void;
  setFilter: (id: string, f: Filter | null) => void;
  clearFilters: () => void;
  filtering: boolean;
}

export function useTableView<T>(data: readonly T[], specs: readonly ColumnSpec<T>[], stateKey?: string): TableView<T> {
  const kinds = useMemo(() => {
    const k: Record<string, ColumnKind> = {};
    for (const s of specs) if (s.kind && s.filterable) k[s.id] = s.kind;
    return k;
  }, [specs]);
  const sortableIds = useMemo(() => specs.filter((s) => s.kind && s.sortable).map((s) => s.id), [specs]);
  const [state, setState] = useUrlState(stateKey, kinds, sortableIds);
  const clock = useTableClock();

  const values = useMemo(() => {
    const m = new Map<string, CellValue[]>();
    for (const s of specs) if (s.kind) m.set(s.id, data.map((r) => s.value(r)));
    return m;
  }, [data, specs]);

  const masks = useMemo(() => {
    const out = new Map<string, Uint8Array>();
    for (const [id, f] of Object.entries(state.filters)) {
      const vs = values.get(id);
      if (!vs || !isActive(f)) continue;
      const pred = compileFilter(f, clock);
      const mask = new Uint8Array(vs.length);
      for (let i = 0; i < vs.length; i++) mask[i] = pred(vs[i]) ? 1 : 0;
      out.set(id, mask);
    }
    return out;
  }, [values, state.filters, clock]);

  const visible = useMemo(() => {
    const ms = [...masks.values()];
    const idx: number[] = [];
    for (let i = 0; i < data.length; i++) if (ms.every((m) => m[i] === 1)) idx.push(i);
    return idx;
  }, [masks, data.length]);

  const rows = useMemo(() => {
    const keys = state.sort.flatMap((k) => {
      const s = specs.find((x) => x.id === k.id);
      const vs = values.get(k.id);
      return s && vs ? [{ values: vs.map((v) => sortable(v, s.format)), desc: k.desc }] : [];
    });
    return sortIndices(visible, keys).map((i) => data[i]!);
  }, [visible, state.sort, specs, values, data]);

  const passExcept = useCallback(
    (id: string) => {
      const ms = [...masks].filter(([k]) => k !== id).map(([, m]) => m);
      return (i: number) => ms.every((m) => m[i] === 1);
    },
    [masks],
  );

  const toggleSort = useCallback((id: string, multi: boolean) => setState({ ...state, sort: nextSort(state.sort, id, multi) }), [state, setState]);
  const setFilter = useCallback(
    (id: string, f: Filter | null) => {
      const filters = Object.fromEntries(Object.entries(state.filters).filter(([k]) => k !== id));
      if (f && isActive(f)) filters[id] = f;
      setState({ ...state, filters });
    },
    [state, setState],
  );
  const clearFilters = useCallback(() => setState({ ...state, filters: {} }), [state, setState]);

  return {
    rows,
    total: data.length,
    state,
    specs,
    values,
    data,
    passExcept,
    toggleSort,
    setFilter,
    clearFilters,
    filtering: masks.size > 0,
  };
}
