// Small fixed tables (one row per tier: tier progress, the solver's load,
// the report's aggregates) as a plain <table class="mini">, with the same
// header controls as DataTable (table/useTable.ts): sortable by default,
// filterable only when `filters` is set, since filtering three rows is
// pointless. A `suppressed` row (the report's small-cell rule) keeps its
// first cell and spans the rest; its values are null, so it sorts last.

import { useMemo, type ReactNode } from "react";
import type { CellValue, ColumnKind } from "../table/model";
import { useTableView, type ColumnSpec } from "../table/useTable";
import { ariaSort, FilterChips, HeaderControls } from "./ColumnFilters";

export interface MiniColumn<T> {
  id: string;
  header: ReactNode;
  /** Plain-text name (default: the header when it is a string). */
  label?: string;
  kind?: ColumnKind;
  value?: (row: T) => CellValue;
  format?: (v: string) => string;
  cell: (row: T) => ReactNode;
  /** A <th scope="row"> rather than a <td>. */
  rowHeader?: boolean;
  className?: string;
  tdAttrs?: (row: T) => Record<string, string>;
}

export function MiniTable<T>({
  rows,
  columns,
  rowKey,
  rowAttrs,
  stateKey,
  testId,
  filters = false,
  suppressed,
}: {
  rows: readonly T[];
  columns: readonly MiniColumn<T>[];
  rowKey: (row: T) => string;
  rowAttrs?: (row: T) => Record<string, string>;
  stateKey: string;
  testId?: string;
  filters?: boolean;
  /** When it returns content, the row shows its first cell and then that, spanning the rest. */
  suppressed?: (row: T) => ReactNode | null;
}) {
  const specs = useMemo<ColumnSpec<T>[]>(
    () =>
      columns.map((c, i) => ({
        id: c.id,
        label: c.label ?? (typeof c.header === "string" ? c.header : c.id),
        kind: c.kind ?? null,
        // A suppressed row has no numbers: null, so it sorts last (its first column still sorts).
        value: (r: T) => (i > 0 && suppressed?.(r) ? null : (c.value?.(r) ?? null)),
        format: c.format,
        sortable: true,
        filterable: filters,
      })),
    [columns, filters, suppressed],
  );
  const view = useTableView(rows, specs, stateKey);
  return (
    <>
      <FilterChips view={view} />
      <table className="mini" data-testid={testId}>
        <thead>
          <tr>
            {columns.map((c, i) => (
              <th key={c.id} scope="col" aria-sort={ariaSort(view, specs[i]!)} data-col={c.id}>
                <HeaderControls view={view} spec={specs[i]}>
                  {c.header}
                </HeaderControls>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {view.rows.map((r) => {
            const s = suppressed?.(r) ?? null;
            const cells = s === null ? columns : columns.slice(0, 1);
            return (
              <tr key={rowKey(r)} {...rowAttrs?.(r)}>
                {cells.map((c) => {
                  const Tag = c.rowHeader ? "th" : "td";
                  return (
                    <Tag key={c.id} scope={c.rowHeader ? "row" : undefined} className={c.className} {...c.tdAttrs?.(r)}>
                      {c.cell(r)}
                    </Tag>
                  );
                })}
                {s}
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}

/** A right-aligned numeric column (sorts by `value`; shows `cell`, default the value). */
export function numColumn<T>(id: string, header: string, value: (r: T) => number | null, cell?: (r: T) => ReactNode, testId?: string): MiniColumn<T> {
  return {
    id,
    header,
    kind: "numeric",
    value,
    className: "num",
    cell: cell ?? ((r) => value(r) ?? "–"),
    tdAttrs: testId ? () => ({ "data-testid": testId }) : undefined,
  };
}
