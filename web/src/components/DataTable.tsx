// A virtualized table (TanStack Table + Virtual) shared by every list view.
// Rows are fixed-height absolutely positioned divs inside one scroll
// container, so 2,400 rows render only what is visible.
//
// Column sort and filter are centralized here (spec §4 "Tables"): a column
// opts in by declaring `meta.kind` (categorical, numeric, date, text,
// boolean), plus `meta.value` when the cell's accessor value is not already a
// plain value. The header then gets a sort button (click: ascending,
// descending, off; shift-click adds a secondary key) and a filter popover
// with the kind's widget; active filters show as chips with "N of M". State
// lives in the URL under `stateKey` (table/model.ts). With no sort chosen the
// rows keep the caller's order (the server's), so no people table defaults to
// a ranking.

import { flexRender, getCoreRowModel, useReactTable, type ColumnDef, type RowData } from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useMemo, useRef, type ReactNode } from "react";
import type { CellValue, ColumnKind } from "../table/model";
import { useTableView, type ColumnSpec, type TableView } from "../table/useTable";
import { ariaSort, FilterChips, HeaderControls } from "./ColumnFilters";

declare module "@tanstack/react-table" {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ColumnMeta<TData extends RowData, TValue> {
    /** Take the remaining width. */
    grow?: boolean;
    /** Enables sort and filter, and picks the filter widget. */
    kind?: ColumnKind;
    /** The value sorted and filtered on (default: the accessor's value). Dates are ms. */
    value?: (row: TData) => CellValue;
    /** Display label for a categorical value (or "true"/"false"). */
    format?: (v: string) => string;
    /** Plain-text name for chips and labels (default: the header when it is a string). */
    label?: string;
    /** false: no sort button. */
    sort?: boolean;
    /** false: no filter button. */
    filter?: boolean;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyColumn<T> = ColumnDef<T, any>;

/** Column widths come from `size` (px); a column with meta.grow takes the rest. */
function template<T>(columns: AnyColumn<T>[]): string {
  return columns.map((c) => (c.meta?.grow ? `minmax(${c.size ?? 120}px, 1fr)` : `${c.size ?? 120}px`)).join(" ");
}

/** Sort/filter specs from TanStack column defs. */
export function specsFromColumns<T>(columns: AnyColumn<T>[]): ColumnSpec<T>[] {
  return columns.map((c, i) => {
    const def = c as AnyColumn<T> & { accessorKey?: string; accessorFn?: (row: T, i: number) => unknown };
    const id = c.id ?? def.accessorKey ?? `col${i}`;
    const m = c.meta ?? {};
    const value: (row: T) => CellValue =
      m.value ??
      (def.accessorFn
        ? (r) => def.accessorFn!(r, 0) as CellValue
        : def.accessorKey
          ? (r) => (r as Record<string, unknown>)[def.accessorKey!] as CellValue
          : () => null);
    return {
      id,
      label: m.label ?? (typeof c.header === "string" && c.header ? c.header : id),
      kind: m.kind ?? null,
      value,
      format: m.format,
      sortable: m.sort !== false,
      filterable: m.filter !== false,
    };
  });
}

/** The sort/filter view of `data` for these columns: for views that need the visible rows themselves (counts, actions). */
export function useDataTableView<T>(data: readonly T[], columns: AnyColumn<T>[], stateKey?: string): TableView<T> {
  const specs = useMemo(() => specsFromColumns(columns), [columns]);
  return useTableView(data, specs, stateKey);
}

export interface DataTableProps<T> {
  data: readonly T[];
  columns: AnyColumn<T>[];
  rowId: (row: T) => string;
  /** URL key for this table's sort/filter state (unique on the page; [a-z0-9-]). Without it the state is local. */
  stateKey?: string;
  /** Extra attributes on each row (e.g. data-pid for tests). */
  rowAttrs?: (row: T) => Record<string, string | number>;
  onRowClick?: (row: T) => void;
  selectedId?: string | null;
  rowHeight?: number;
  testId?: string;
  empty?: ReactNode;
  /** Size the table to its rows, up to this many (else it fills its container). */
  maxRows?: number;
  /** What the rows are, for "N of M papers". */
  noun?: string;
}

export function DataTable<T>(props: DataTableProps<T>) {
  const view = useDataTableView(props.data, props.columns, props.stateKey);
  return <DataTableView {...props} view={view} />;
}

const HEAD_H = 36;
const CHIPS_H = 34;

export function DataTableView<T>({
  view,
  columns,
  rowId,
  rowAttrs,
  onRowClick,
  selectedId,
  rowHeight = 44,
  testId,
  empty,
  maxRows,
  noun,
}: Omit<DataTableProps<T>, "data" | "stateKey"> & { view: TableView<T> }) {
  const table = useReactTable({
    data: view.rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (r) => rowId(r),
  });
  const scroller = useRef<HTMLDivElement>(null);
  const rows = table.getRowModel().rows;
  const virt = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => rowHeight,
    overscan: 10,
  });
  const cols = template(columns);
  const specs = useMemo(() => new Map(view.specs.map((s) => [s.id, s])), [view.specs]);
  const height = maxRows === undefined ? undefined : (view.filtering ? CHIPS_H : 0) + HEAD_H + Math.max(1, Math.min(rows.length, maxRows)) * rowHeight;

  return (
    <div className="dt" role="table" data-testid={testId} style={height === undefined ? undefined : { height, flex: "none" }}>
      <FilterChips view={view} noun={noun} />
      <div className="dt-head" role="rowgroup">
        {table.getHeaderGroups().map((hg) => (
          <div key={hg.id} className="dt-row dt-header" role="row" style={{ gridTemplateColumns: cols }}>
            {hg.headers.map((h) => {
              const spec = specs.get(h.column.id);
              return (
                <div key={h.id} className="dt-cell dt-hcell" role="columnheader" aria-sort={spec ? ariaSort(view, spec) : undefined} data-col={h.column.id}>
                  {h.isPlaceholder ? null : (
                    <HeaderControls view={view} spec={spec}>
                      {flexRender(h.column.columnDef.header, h.getContext())}
                    </HeaderControls>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <div className="dt-body" ref={scroller} role="rowgroup">
        {rows.length === 0 ? (
          <div className="dt-empty">
            {view.filtering && view.total > 0 ? (
              <>
                No rows match the column filters.{" "}
                <button type="button" className="btn btn-small" onClick={view.clearFilters}>
                  Clear all
                </button>
              </>
            ) : (
              (empty ?? "Nothing to show.")
            )}
          </div>
        ) : (
          <div style={{ height: virt.getTotalSize(), position: "relative" }}>
            {virt.getVirtualItems().map((vi) => {
              const row = rows[vi.index]!;
              const selected = selectedId !== undefined && selectedId === row.id;
              return (
                <div
                  key={row.id}
                  className={`dt-row${onRowClick ? " dt-clickable" : ""}${selected ? " dt-selected" : ""}`}
                  role="row"
                  aria-selected={selected || undefined}
                  style={{ gridTemplateColumns: cols, height: rowHeight, transform: `translateY(${vi.start}px)` }}
                  onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                  {...rowAttrs?.(row.original)}
                >
                  {row.getVisibleCells().map((cell) => (
                    <div key={cell.id} className="dt-cell" role="cell">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
