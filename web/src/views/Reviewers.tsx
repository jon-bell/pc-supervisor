// Reviewer outlier lists (spec §5a), split by tier. A person appears only when
// they cross a list's absolute bar (shown under its heading), so these are
// filtered lists, not a ranking: no rank numbers, and the sort is by name, so
// the list never reads as a leaderboard (spec §2, §7); ?sort=count sorts by
// count instead. Clicking a row opens the person page.

import { createColumnHelper } from "@tanstack/react-table";
import { useMemo } from "react";
import { personPath, useReviewers, type OutlierEntry, type OutlierList } from "../api";
import { DataTable } from "../components/DataTable";
import { plural, tierLabel } from "../format";
import { Link, navigate, useLocation } from "../router";

const col = createColumnHelper<OutlierEntry>();
const ROW = 36;
const MAX_ROWS = 8;

type SortKey = "count" | "name";

function sortEntries(entries: readonly OutlierEntry[], sort: SortKey): OutlierEntry[] {
  const byName = (a: OutlierEntry, b: OutlierEntry) => a.person.name.localeCompare(b.person.name) || a.person.email.localeCompare(b.person.email);
  return [...entries].sort(sort === "name" ? byName : (a, b) => b.count - a.count || byName(a, b));
}

function TierGroup({ list, tier, entries, sort }: { list: OutlierList; tier: string; entries: OutlierEntry[]; sort: SortKey }) {
  const columns = useMemo(
    () => [
      col.display({
        id: "name",
        header: "Reviewer",
        size: 200,
        cell: (c) => (
          <Link to={personPath(c.row.original.person.email)} data-testid="outlier-name" onClick={(e) => e.stopPropagation()}>
            {c.row.original.person.name}
          </Link>
        ),
      }),
      col.accessor("count", {
        header: "Count",
        size: 70,
        cell: (c) => (
          <span className="num" data-testid="outlier-count">
            {c.getValue()}
          </span>
        ),
      }),
      col.accessor("pids", {
        header: "Papers",
        size: 160,
        cell: (c) => (
          <span className="pids" data-testid="outlier-pids">
            {c.getValue().map((p, i) => (
              <span key={p}>
                {i ? " " : ""}
                <Link to={`/papers/${p}`} onClick={(e) => e.stopPropagation()}>
                  #{p}
                </Link>
              </span>
            ))}
          </span>
        ),
      }),
      col.accessor("detail", {
        header: "Detail",
        size: 300,
        meta: { grow: true },
        cell: (c) => (
          <span className="ellipsis" title={c.getValue()} data-testid="outlier-detail">
            {c.getValue()}
          </span>
        ),
      }),
    ],
    [],
  );
  const rows = sortEntries(entries, sort);
  return (
    <div className="tier-group" data-testid="tier-group" data-list={list.id} data-tier={tier}>
      <h3>
        {tierLabel(tier)} <span className="muted">({rows.length})</span>
      </h3>
      {rows.length === 0 ? (
        <p className="muted none">No one in this tier is over the bar.</p>
      ) : (
        <div className="tier-table" style={{ height: 36 + Math.min(rows.length, MAX_ROWS) * ROW }}>
          <DataTable
            data={rows}
            columns={columns}
            rowHeight={ROW}
            rowId={(r) => r.person.email}
            rowAttrs={(r) => ({ "data-testid": "outlier-row", "data-email": r.person.email })}
            onRowClick={(r) => navigate(personPath(r.person.email))}
          />
        </div>
      )}
    </div>
  );
}

export function Reviewers() {
  const loc = useLocation();
  const sort: SortKey = loc.query.get("sort") === "count" ? "count" : "name";
  const q = useReviewers();
  const data = q.data;
  const setSort = (s: SortKey) => navigate(s === "name" ? loc.path : `${loc.path}?sort=count`, { replace: true });

  return (
    <div className="page page-scroll">
      <div className="page-head">
        <h1>Reviewers</h1>
        <p className="muted">
          Outlier lists, not a ranking: each list shows only people over its bar, split by tier.
          {data ? ` ${plural(data.reviewers, "reviewer")} in the local store.` : null}
        </p>
        <div className="sort" role="group" aria-label="Sort">
          Sort by{" "}
          <button type="button" className={`btn${sort === "name" ? " btn-on" : ""}`} data-testid="sort-name" onClick={() => setSort("name")}>
            name
          </button>{" "}
          <button type="button" className={`btn${sort === "count" ? " btn-on" : ""}`} data-testid="sort-count" onClick={() => setSort("count")}>
            count
          </button>
        </div>
      </div>
      {q.error ? <p className="error">Could not load the reviewer lists: {q.error.message}</p> : null}
      {!data && !q.error ? <p className="muted">Loading…</p> : null}
      {data?.lists.map((list) => (
        <section key={list.id} className="outlier-list" data-testid="outlier-list" data-list={list.id}>
          <h2>
            {list.label} <span className="muted">({list.total})</span>
          </h2>
          <p className="muted bar">Shown when: {list.bar}.</p>
          {list.byTier.map((g) => (
            <TierGroup key={g.tier} list={list} tier={g.tier} entries={g.entries} sort={sort} />
          ))}
        </section>
      ))}
    </div>
  );
}
