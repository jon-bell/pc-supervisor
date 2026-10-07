// The triage list (spec §5c): every paper in severity order, then time to
// decisions due, then pid (the server's order), with reason chips. Filters
// live in the URL (?ac=&rule=&tier=) so a filtered list deep-links; clicking a
// row opens the paper drawer at /papers/:pid.

import { createColumnHelper } from "@tanstack/react-table";
import { useMemo } from "react";
import { useTriage, type MetaResponse, type TriageFilters, type TriageRow } from "../api";
import { ReasonChips } from "../components/Chip";
import { DataTable } from "../components/DataTable";
import { RelTime } from "../components/Time";
import { hotcrp, plural, ruleLabel } from "../format";
import { navigate, useLocation } from "../router";
import { PaperDrawer } from "./PaperDrawer";

const col = createColumnHelper<TriageRow>();

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

  const columns = useMemo(
    () => [
      col.accessor("pid", {
        header: "#",
        size: 56,
        cell: (c) => <span className="pid" data-testid="pid">#{c.getValue()}</span>,
      }),
      col.accessor("title", {
        header: "Title",
        size: 220,
        meta: { grow: true },
        cell: (c) => (
          <span className="title" title={c.getValue()} data-testid="title">
            {c.getValue()}
          </span>
        ),
      }),
      col.accessor("acs", {
        header: "AC",
        size: 150,
        cell: (c) => <span className="ellipsis">{c.getValue().map((a) => a.name).join(", ") || <span className="muted">none</span>}</span>,
      }),
      col.display({
        id: "scores",
        header: "Merit",
        size: 92,
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
        size: 360,
        cell: (c) => <ReasonChips reasons={c.getValue()} />,
      }),
      col.accessor("severity", {
        header: "Sev.",
        size: 52,
        cell: (c) => <span className="sev" data-testid="severity">{c.getValue()}</span>,
      }),
      col.accessor("lastActivity", {
        header: "Last activity",
        size: 120,
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
    [base, data?.now, meta.now, meta.tz],
  );

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
          <span className="count" data-testid="triage-count">
            {data ? `${data.papers.length} of ${plural(data.total, "paper")}` : "Loading…"}
          </span>
        </div>
        {triage.error ? (
          <p className="error">Could not load the triage list: {triage.error.message}</p>
        ) : (
          <DataTable
            testId="triage-table"
            data={data?.papers ?? []}
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
    </div>
  );
}
