// A virtualized table (TanStack Table + Virtual) shared by every list view:
// triage now, the AC table and reviewer lists in M6. Rows are fixed-height
// absolutely positioned divs inside one scroll container, so 2,400 rows render
// only what is visible. Order is whatever the caller passes (the server sorts).

import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useRef, type ReactNode } from "react";

export interface DataTableProps<T> {
  data: readonly T[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  columns: ColumnDef<T, any>[];
  rowId: (row: T) => string;
  /** Extra attributes on each row (e.g. data-pid for tests). */
  rowAttrs?: (row: T) => Record<string, string | number>;
  onRowClick?: (row: T) => void;
  selectedId?: string | null;
  rowHeight?: number;
  testId?: string;
  empty?: ReactNode;
}

/** Column widths come from `size` (px); a column with meta.grow takes the rest. */
function template<T>(columns: ColumnDef<T, unknown>[]): string {
  return columns
    .map((c) => ((c.meta as { grow?: boolean } | undefined)?.grow ? `minmax(${c.size ?? 120}px, 1fr)` : `${c.size ?? 120}px`))
    .join(" ");
}

export function DataTable<T>({ data, columns, rowId, rowAttrs, onRowClick, selectedId, rowHeight = 44, testId, empty }: DataTableProps<T>) {
  const table = useReactTable({
    data: data as T[],
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
  const cols = template(columns as ColumnDef<T, unknown>[]);

  return (
    <div className="dt" role="table" data-testid={testId}>
      <div className="dt-head" role="rowgroup">
        {table.getHeaderGroups().map((hg) => (
          <div key={hg.id} className="dt-row dt-header" role="row" style={{ gridTemplateColumns: cols }}>
            {hg.headers.map((h) => (
              <div key={h.id} className="dt-cell" role="columnheader">
                {h.isPlaceholder ? null : flexRender(h.column.columnDef.header, h.getContext())}
              </div>
            ))}
          </div>
        ))}
      </div>
      <div className="dt-body" ref={scroller} role="rowgroup">
        {rows.length === 0 ? (
          <div className="dt-empty">{empty ?? "Nothing to show."}</div>
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
