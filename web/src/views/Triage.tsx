// The triage list (spec §5c): every paper in severity order, then time to
// decisions due, then pid (the server's order), with reason chips. Filters
// live in the URL (?ac=&rule=&tier=) so a filtered list deep-links; they sit
// in the paper filter bar (portalled into its slot), so search and filters
// are one bar. Under it, one contextual action bar: the count, the HotCRP
// search for the visible rows and the PCS_ATTENTION_TAG actions (PLAN M8).
// Clicking a row opens the paper drawer at /papers/:pid beside the list, in a
// resizable split; while it is open the list keeps only severity, #, title
// and merit, so the key columns stay visible.
// Column headers sort and filter further in the browser (DataTable, URL key
// "tri"); the count, the search and the tag actions follow the visible rows.

import { createColumnHelper } from "@tanstack/react-table";
import { useContext, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useActions, useTriage, type MetaResponse, type TriageFilters, type TriageRow } from "../api";
import { SearchActions, TagDialog } from "../components/Actions";
import { Chip, ReasonChips } from "../components/Chip";
import { DataTableView, useDataTableView } from "../components/DataTable";
import { FilterSlotContext } from "../components/PaperFilter";
import { SeverityCell } from "../components/Severity";
import { RelTime } from "../components/Time";
import { hotcrp, plural, ruleLabel } from "../format";
import { MeritCell } from "../scores";
import { mean } from "../table/model";
import { navigate, useLocation } from "../router";
import { PaperDrawer } from "./PaperDrawer";

const col = createColumnHelper<TriageRow>();
const NO_ROWS: TriageRow[] = [];
/** Columns kept while the drawer is open. */
const COMPACT: ReadonlySet<string> = new Set(["severity", "pid", "title", "scores"]);

function filtersFrom(q: URLSearchParams): TriageFilters {
  return { ac: q.get("ac") ?? undefined, rule: q.get("rule") ?? undefined, tier: q.get("tier") ?? undefined };
}

function withQuery(path: string, f: TriageFilters): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v) q.set(k, v);
  const s = q.toString();
  return s ? `${path}?${s}` : path;
}

const DRAWER_KEY = "pcs.drawer-width";
const DRAWER_MIN = 380;
const DRAWER_DEFAULT = 560;
function readDrawerWidth(): number {
  try {
    const v = Number(window.localStorage.getItem(DRAWER_KEY));
    return Number.isFinite(v) && v >= DRAWER_MIN ? v : DRAWER_DEFAULT;
  } catch {
    return DRAWER_DEFAULT;
  }
}
function saveDrawerWidth(w: number) {
  try {
    window.localStorage.setItem(DRAWER_KEY, String(Math.round(w)));
  } catch {
    // A convenience only.
  }
}

/** The drag handle between the list and the drawer (pointer or arrow keys). */
function Splitter({ width, setWidth, container }: { width: number; setWidth: (w: number) => void; container: RefObject<HTMLDivElement | null> }) {
  const max = () => Math.max(DRAWER_MIN, (container.current?.clientWidth ?? 1200) - 360);
  const clamp = (w: number) => Math.min(max(), Math.max(DRAWER_MIN, w));
  const down = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const right = container.current?.getBoundingClientRect().right ?? window.innerWidth;
    const move = (ev: globalThis.PointerEvent) => setWidth(clamp(right - ev.clientX));
    const up = (ev: globalThis.PointerEvent) => {
      el.releasePointerCapture(ev.pointerId);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      saveDrawerWidth(clamp(right - ev.clientX));
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 80 : 24;
    let w: number | null = null;
    if (e.key === "ArrowLeft") w = clamp(width + step);
    else if (e.key === "ArrowRight") w = clamp(width - step);
    else if (e.key === "Home") w = max();
    else if (e.key === "End") w = DRAWER_MIN;
    if (w === null) return;
    e.preventDefault();
    setWidth(w);
    saveDrawerWidth(w);
  };
  return (
    <div
      className="splitter"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the paper drawer"
      aria-valuemin={DRAWER_MIN}
      aria-valuemax={max()}
      aria-valuenow={Math.round(width)}
      tabIndex={0}
      onPointerDown={down}
      onKeyDown={key}
      data-testid="drawer-splitter"
    />
  );
}

export function Triage({ meta, pid }: { meta: MetaResponse; pid: number | null }) {
  const loc = useLocation();
  const filters = filtersFrom(loc.query);
  const triage = useTriage(filters);
  const data = triage.data;
  const base = meta.hotcrpUrl;
  const actions = useActions().data;
  const tag = actions?.attentionTag;
  const [tagging, setTagging] = useState<{ add: number[]; remove: number[] } | null>(null);
  const slot = useContext(FilterSlotContext);
  const [drawerWidth, setDrawerWidth] = useState(readDrawerWidth);
  const split = useRef<HTMLDivElement>(null);
  const maxSev = useMemo(() => Math.max(0, ...(data?.papers ?? NO_ROWS).map((p) => p.severity)), [data]);

  const columns = useMemo(
    () => [
      col.accessor("severity", {
        header: "Sev.",
        size: 92,
        meta: { kind: "numeric", label: "Severity" },
        cell: (c) => <SeverityCell sev={c.getValue()} max={maxSev} />,
      }),
      col.accessor("pid", {
        header: "#",
        size: 60,
        meta: { kind: "numeric", label: "Paper" },
        cell: (c) => <span className="pid" data-testid="pid">#{c.getValue()}</span>,
      }),
      col.accessor("title", {
        header: "Title",
        size: 220,
        meta: { grow: true, kind: "text" },
        cell: (c) => (
          <span className="title-cell">
            <span className="title" title={c.getValue()} data-testid="title">
              {c.getValue()}
            </span>
            {tag && c.row.original.tags.some((t) => t.replace(/#.*$/, "").toLowerCase() === tag.toLowerCase()) ? (
              <Chip tone="info" testId="attention-tag">
                #{tag}
              </Chip>
            ) : null}
          </span>
        ),
      }),
      col.display({
        id: "scores",
        header: "Merit",
        size: 168,
        meta: { kind: "numeric", label: "Mean merit", value: (r) => mean(r.merits) },
        cell: (c) => {
          const r = c.row.original;
          const items = r.scores.filter((s) => s.merit !== null).map((s) => ({ merit: s.merit, expertise: s.expertise, label: s.ordinal ? `Review ${s.ordinal}` : undefined }));
          return <MeritCell items={items} submitted={r.reviews.submitted} assigned={r.reviews.assigned} testId="scores" />;
        },
      }),
      col.accessor("reasons", {
        header: "Reasons",
        size: 380,
        meta: { kind: "categorical", value: (r) => r.reasons.map((x) => x.rule), format: ruleLabel },
        cell: (c) => <ReasonChips reasons={c.getValue()} max={3} />,
      }),
      col.accessor("acs", {
        header: "AC",
        size: 140,
        meta: { kind: "categorical", value: (r) => r.acs.map((a) => a.name) },
        cell: (c) => <span className="ellipsis">{c.getValue().map((a) => a.name).join(", ") || <span className="muted">none</span>}</span>,
      }),
      col.accessor("lastActivity", {
        header: "Last activity",
        size: 116,
        meta: { kind: "date" },
        cell: (c) => <RelTime ms={c.getValue()} now={data?.now ?? meta.now} tz={meta.tz} />,
      }),
      col.display({
        id: "link",
        header: "HotCRP",
        size: 76,
        cell: (c) => (
          <a
            className="ext"
            href={hotcrp.paper(base, c.row.original.pid)}
            target="_blank"
            rel="noreferrer noopener"
            data-testid="hotcrp-link"
            onClick={(e) => e.stopPropagation()}
          >
            open ↗
          </a>
        ),
      }),
    ],
    [base, data?.now, meta.now, meta.tz, tag, maxSev],
  );

  const view = useDataTableView(data?.papers ?? NO_ROWS, columns, "tri");
  const shown = view.rows;
  const open = pid !== null;
  const visibleColumns = useMemo(() => (open ? columns.filter((c) => COMPACT.has(c.id ?? (c as { accessorKey?: string }).accessorKey ?? "")) : columns), [columns, open]);

  const setFilter = (k: keyof TriageFilters, v: string) => navigate(withQuery(loc.path, { ...filters, [k]: v || undefined }), { replace: true });

  const filterControls = (
    <div className="filters" data-testid="filters">
      <label>
        <span>AC</span>
        <select data-testid="filter-ac" value={filters.ac ?? ""} onChange={(e) => setFilter("ac", e.target.value)}>
          <option value="">All ACs</option>
          {data?.facets.acs.map((a) => (
            <option key={a.email} value={a.email}>
              {a.name} ({a.papers})
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>Rule</span>
        <select data-testid="filter-rule" value={filters.rule ?? ""} onChange={(e) => setFilter("rule", e.target.value)}>
          <option value="">Any rule</option>
          {data?.facets.rules.map((r) => (
            <option key={r.rule} value={r.rule}>
              {ruleLabel(r.rule)} ({r.papers})
            </option>
          ))}
        </select>
      </label>
      {meta.tiersConfigured ? (
        <label>
          <span>Tier</span>
          <select data-testid="filter-tier" value={filters.tier ?? ""} onChange={(e) => setFilter("tier", e.target.value)}>
            <option value="">Any tier</option>
            {data?.facets.tiers.map((t) => (
              <option key={t.tier} value={t.tier}>
                {t.tier} ({t.papers})
              </option>
            ))}
          </select>
        </label>
      ) : null}
    </div>
  );

  const count = (
    <span className="count" data-testid="triage-count">
      {data ? `${shown.length} of ${plural(data.total, "paper")}` : "Loading…"}
    </span>
  );

  return (
    <div className={`triage${open ? " triage-split" : ""}`} ref={split}>
      {slot ? createPortal(filterControls, slot) : filterControls}
      <section className="list-pane">
        {data ? (
          <SearchActions pids={shown.map((p) => p.pid)} base={base} lead={count}>
            {tag && actions?.taggingAvailable && shown.length > 0 ? (
              <>
                <button type="button" className="btn btn-ghost" data-testid="tag-add-all" onClick={() => setTagging({ add: shown.map((p) => p.pid), remove: [] })}>
                  Tag these #{tag}…
                </button>
                <button type="button" className="btn btn-ghost" data-testid="tag-remove-all" onClick={() => setTagging({ add: [], remove: shown.map((p) => p.pid) })}>
                  Remove #{tag}…
                </button>
              </>
            ) : null}
          </SearchActions>
        ) : (
          <div className="actions-bar">{count}</div>
        )}
        {triage.error ? (
          <p className="error">Could not load the triage list: {triage.error.message}</p>
        ) : (
          <DataTableView
            testId="triage-table"
            view={view}
            noun="papers"
            columns={visibleColumns}
            rowId={(r) => String(r.pid)}
            rowAttrs={(r) => ({ "data-testid": "triage-row", "data-pid": r.pid })}
            selectedId={pid === null ? null : String(pid)}
            onRowClick={(r) => navigate(withQuery(`/papers/${r.pid}`, filters))}
            empty={data ? "No papers match these filters." : "Loading…"}
          />
        )}
      </section>
      {open ? (
        <>
          <Splitter width={drawerWidth} setWidth={setDrawerWidth} container={split} />
          <PaperDrawer pid={pid} meta={meta} width={drawerWidth} onClose={() => navigate(withQuery("/", filters))} />
        </>
      ) : null}
      {tagging && tag ? <TagDialog tag={tag} add={tagging.add} remove={tagging.remove} onClose={() => setTagging(null)} /> : null}
    </div>
  );
}
