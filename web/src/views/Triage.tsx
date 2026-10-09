// The triage list (spec §5c): every paper in severity order, then time to
// decisions due, then pid (the server's order), with reason chips. Filters
// live in the URL (?ac=&rule=&tier=) so a filtered list deep-links; clicking a
// row opens the paper drawer at /papers/:pid. The actions bar (PLAN M8) copies
// a HotCRP search for the filtered set and tags it PCS_ATTENTION_TAG.
// Column headers sort and filter further in the browser (DataTable, URL key
// "tri"); the count, the search and the tag actions follow the visible rows.

import { createColumnHelper } from "@tanstack/react-table";
import { useMemo, useState } from "react";
import { useActions, useTriage, type MetaResponse, type TriageFilters, type TriageRow } from "../api";
import { SearchActions, TagDialog } from "../components/Actions";
import { Chip, ReasonChips } from "../components/Chip";
import { DataTableView, useDataTableView } from "../components/DataTable";
import { RelTime } from "../components/Time";
import { hotcrp, plural, ruleLabel } from "../format";
import { mean } from "../table/model";
import { navigate, useLocation } from "../router";
import { PaperDrawer } from "./PaperDrawer";

const col = createColumnHelper<TriageRow>();
const NO_ROWS: TriageRow[] = [];

function filtersFrom(q: URLSearchParams): TriageFilters {
  return { ac: q.get("ac") ?? undefined, rule: q.get("rule") ?? undefined, tier: q.get("tier") ?? undefined };
}

function withQuery(path: string, f: TriageFilters): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v) q.set(k, v);
  const s = q.toString();
  return s ? `${path}?${s}` : path;
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

  const columns = useMemo(
    () => [
      col.accessor("pid", {
        header: "#",
        size: 64,
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
      col.accessor("acs", {
        header: "AC",
        size: 150,
        meta: { kind: "categorical", value: (r) => r.acs.map((a) => a.name) },
        cell: (c) => <span className="ellipsis">{c.getValue().map((a) => a.name).join(", ") || <span className="muted">none</span>}</span>,
      }),
      col.display({
        id: "scores",
        header: "Merit",
        size: 92,
        meta: { kind: "numeric", label: "Mean merit", value: (r) => mean(r.merits) },
        cell: (c) => {
          const r = c.row.original;
          return (
            <span className="scores" title={`${r.reviews.submitted} of ${r.reviews.assigned} reviews submitted`} data-testid="scores">
              {r.merits.join("/") || "–"}
              {r.reviews.submitted < r.reviews.assigned ? <span className="muted"> ({r.reviews.submitted}/{r.reviews.assigned})</span> : null}
            </span>
          );
        },
      }),
      col.accessor("reasons", {
        header: "Reasons",
        size: 420,
        meta: { kind: "categorical", value: (r) => r.reasons.map((x) => x.rule), format: ruleLabel },
        cell: (c) => <ReasonChips reasons={c.getValue()} />,
      }),
      col.accessor("severity", {
        header: "Sev.",
        size: 76,
        meta: { kind: "numeric", label: "Severity" },
        cell: (c) => <span className="sev" data-testid="severity">{c.getValue()}</span>,
      }),
      col.accessor("lastActivity", {
        header: "Last activity",
        size: 130,
        meta: { kind: "date" },
        cell: (c) => <RelTime ms={c.getValue()} now={data?.now ?? meta.now} tz={meta.tz} />,
      }),
      col.display({
        id: "link",
        header: "HotCRP",
        size: 84,
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
    [base, data?.now, meta.now, meta.tz, tag],
  );

  const view = useDataTableView(data?.papers ?? NO_ROWS, columns, "tri");
  const shown = view.rows;

  const setFilter = (k: keyof TriageFilters, v: string) => navigate(withQuery(loc.path, { ...filters, [k]: v || undefined }), { replace: true });

  return (
    <div className="triage">
      <section className="list-pane">
        <div className="filters" data-testid="filters">
          <label>
            AC{" "}
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
            Rule{" "}
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
              Tier{" "}
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
          <span className="count" data-testid="triage-count">
            {data ? `${shown.length} of ${plural(data.total, "paper")}` : "Loading…"}
          </span>
        </div>
        {data ? (
          <SearchActions pids={shown.map((p) => p.pid)} base={base}>
            {tag && actions?.taggingAvailable && shown.length > 0 ? (
              <>
                <button type="button" className="btn" data-testid="tag-add-all" onClick={() => setTagging({ add: shown.map((p) => p.pid), remove: [] })}>
                  Tag these #{tag}…
                </button>
                <button type="button" className="btn" data-testid="tag-remove-all" onClick={() => setTagging({ add: [], remove: shown.map((p) => p.pid) })}>
                  Remove #{tag}…
                </button>
              </>
            ) : null}
          </SearchActions>
        ) : null}
        {triage.error ? (
          <p className="error">Could not load the triage list: {triage.error.message}</p>
        ) : (
          <DataTableView
            testId="triage-table"
            view={view}
            noun="papers"
            columns={columns}
            rowId={(r) => String(r.pid)}
            rowAttrs={(r) => ({ "data-testid": "triage-row", "data-pid": r.pid })}
            selectedId={pid === null ? null : String(pid)}
            onRowClick={(r) => navigate(withQuery(`/papers/${r.pid}`, filters))}
            empty={data ? "No papers match these filters." : "Loading…"}
          />
        )}
      </section>
      {pid !== null ? <PaperDrawer pid={pid} meta={meta} onClose={() => navigate(withQuery("/", filters))} /> : null}
      {tagging && tag ? <TagDialog tag={tag} add={tagging.add} remove={tagging.remove} onClose={() => setTagging(null)} /> : null}
    </div>
  );
}
