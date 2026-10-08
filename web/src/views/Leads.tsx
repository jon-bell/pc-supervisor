// Discussion leads (HotCRP `lead`; spec §5b "Discussion leads"): the AC
// table's analogue, one row per lead, alphabetical (not a ranking). Each row
// shows their papers (load vs flagged), review progress, everyone's comments
// on those papers, and whether the lead has commented yet. Clicking a row
// opens that lead's papers (/leads/:email); clicking a paper opens its drawer.
// Wording follows spec §7: "no comments yet", never a judgement.

import { createColumnHelper } from "@tanstack/react-table";
import { useMemo } from "react";
import { leadPath, personPath, useLead, useLeads, type LeadPaper, type LeadRow, type MetaResponse } from "../api";
import { SearchActions } from "../components/Actions";
import { LoadBar, Sparkline } from "../components/Charts";
import { ReasonChips } from "../components/Chip";
import { DataTable } from "../components/DataTable";
import { AbsTime, RelTime } from "../components/Time";
import { plural } from "../format";
import { Link, navigate } from "../router";

const col = createColumnHelper<LeadRow>();
const pcol = createColumnHelper<LeadPaper>();

const pidList = (pids: readonly number[]) => pids.map((p) => `#${p}`).join(", ") || "none";

/** "4 of 6 papers" / "no comments yet". */
function LeadCommented({ r }: { r: LeadRow }) {
  const n = r.commentedPids.length;
  if (n === 0) return <span className="muted">no comments yet</span>;
  return (
    <>
      on {n} of {plural(r.load, "paper")}
      {r.notYetPids.length ? <span className="muted"> · not yet on {pidList(r.notYetPids)}</span> : null}
    </>
  );
}

export function Leads({ meta }: { meta: MetaResponse }) {
  const q = useLeads();
  const data = q.data;
  const maxLoad = data?.maxLoad ?? 0;

  const columns = useMemo(
    () => [
      col.display({
        id: "name",
        header: "Discussion lead",
        size: 170,
        cell: (c) => (
          <Link to={personPath(c.row.original.person.email)} className="ellipsis" data-testid="lead-name" onClick={(e) => e.stopPropagation()}>
            {c.row.original.person.name}
          </Link>
        ),
      }),
      col.display({
        id: "load",
        header: "Papers · flagged",
        size: 220,
        cell: (c) => {
          const r = c.row.original;
          return (
            <span className="load" title={`flagged: ${pidList(r.flaggedPids)}`}>
              <span data-testid="lead-load" data-load={r.load} data-flagged={r.flagged}>
                {plural(r.load, "paper")} · {r.flagged} flagged
              </span>
              <LoadBar load={r.load} flagged={r.flagged} max={maxLoad} />
            </span>
          );
        },
      }),
      col.display({
        id: "reviews",
        header: "Reviews",
        size: 150,
        cell: (c) => {
          const v = c.row.original.reviews;
          return (
            <span className="num" data-testid="lead-reviews" title={`${v.complete} of their papers have all required reviews`}>
              {v.submitted}/{v.assigned} submitted
            </span>
          );
        },
      }),
      col.display({
        id: "comments",
        header: "Comments on papers",
        size: 160,
        cell: (c) => {
          const v = c.row.original.comments;
          return (
            <span className="num" data-testid="lead-comments" title={`published comments by anyone: ${v.total} in all, ${v.discussion} since discussion opened`}>
              {v.total}
              {v.total !== v.discussion ? <span className="muted"> ({v.discussion} since open)</span> : null}
            </span>
          );
        },
      }),
      col.display({
        id: "lead",
        header: "Lead has commented",
        size: 230,
        cell: (c) => (
          <span className="ellipsis" data-testid="lead-commented" data-commented={c.row.original.commentedPids.length}>
            <LeadCommented r={c.row.original} />
          </span>
        ),
      }),
      col.display({
        id: "stale",
        header: "Stale",
        size: 64,
        cell: (c) => (
          <span className="num" data-testid="lead-stale" title={pidList(c.row.original.stalePids)}>
            {c.row.original.stale}
          </span>
        ),
      }),
      col.display({
        id: "activity",
        header: "Activity",
        size: 140,
        meta: { grow: true },
        cell: (c) => <Sparkline daily={c.row.original.activity.daily} start={c.row.original.activity.start} tz={meta.tz} testId="lead-spark" />,
      }),
    ],
    [maxLoad, meta.tz],
  );

  const noLeads = data && data.leads.length === 0;
  return (
    <div className="page">
      <div className="page-head">
        <h1>Discussion leads</h1>
        <p className="muted">
          One row per discussion lead (HotCRP&apos;s <em>lead</em> field), alphabetical. Comments count every published comment on their papers;
          &ldquo;lead has commented&rdquo; counts the lead&apos;s own. Click a row to see that lead&apos;s papers.
          {data && data.papersWithLead > 0 ? ` ${data.papersWithLead} of ${plural(data.papers, "paper")} have a lead.` : ""}
        </p>
      </div>
      {q.error ? (
        <p className="error">Could not load the discussion leads: {q.error.message}</p>
      ) : noLeads ? (
        <div className="empty-state" data-testid="leads-empty">
          <p>
            <strong>No paper has a discussion lead yet</strong>
            {data.papers ? ` (0 of ${plural(data.papers, "paper")}).` : "."}
          </p>
          <p className="muted">
            Assign leads in HotCRP (on a paper&apos;s page, or in bulk with an assignment CSV using the <code>lead</code> action), then sync. This
            view groups papers by their lead; the area-chair view stays on the <Link to="/acs">ACs</Link> page.
          </p>
        </div>
      ) : (
        <DataTable
          testId="lead-table"
          data={data?.leads ?? []}
          columns={columns}
          rowId={(r) => r.person.email}
          rowAttrs={(r) => ({ "data-testid": "lead-row", "data-email": r.person.email })}
          onRowClick={(r) => navigate(leadPath(r.person.email))}
          empty={data ? "No discussion leads." : "Loading…"}
        />
      )}
    </div>
  );
}

export function LeadDetail({ meta, email }: { meta: MetaResponse; email: string }) {
  const q = useLead(email);
  const d = q.data;

  const columns = useMemo(
    () => [
      pcol.accessor("pid", { header: "#", size: 52, cell: (c) => <span className="pid">#{c.getValue()}</span> }),
      pcol.accessor("title", {
        header: "Title",
        size: 180,
        meta: { grow: true },
        cell: (c) => (
          <span className="title" title={c.getValue()}>
            {c.getValue()}
          </span>
        ),
      }),
      pcol.display({
        id: "acs",
        header: "AC",
        size: 130,
        cell: (c) => <span className="ellipsis">{c.row.original.acs.map((a) => a.name).join(", ") || <span className="muted">none</span>}</span>,
      }),
      pcol.display({
        id: "reviews",
        header: "Reviews",
        size: 120,
        cell: (c) => {
          const v = c.row.original.reviews;
          return (
            <span className={`num${d && v.submitted < d.reviewsRequired ? " warn-text" : ""}`} data-testid="lp-reviews">
              {v.submitted}/{v.assigned} submitted
            </span>
          );
        },
      }),
      pcol.accessor("merits", { header: "Merits", size: 80, cell: (c) => <span className="scores">{c.getValue().join("/") || "–"}</span> }),
      pcol.display({
        id: "comments",
        header: "Comments",
        size: 110,
        cell: (c) => {
          const v = c.row.original.comments;
          return (
            <span className="num" data-testid="lp-comments" title={`${v.total} in all, ${v.discussion} since discussion opened`}>
              {v.total}
              {v.total !== v.discussion ? <span className="muted"> ({v.discussion} since open)</span> : null}
            </span>
          );
        },
      }),
      pcol.display({
        id: "lead",
        header: "Lead's last comment",
        size: 190,
        cell: (c) => {
          const p = c.row.original;
          if (p.leadLastComment === null) return <span className="muted" data-testid="lp-lead">no comments yet</span>;
          return (
            <span className="ellipsis" data-testid="lp-lead" data-count={p.leadComments.total}>
              <AbsTime ms={p.leadLastComment} tz={meta.tz} />
              {p.leadComments.total > 1 ? <span className="muted"> · {p.leadComments.total} in all</span> : null}
            </span>
          );
        },
      }),
      pcol.display({
        id: "last",
        header: "Last activity",
        size: 110,
        cell: (c) => <RelTime ms={c.row.original.lastActivity} now={d?.now ?? 0} tz={meta.tz} />,
      }),
      pcol.display({
        id: "flags",
        header: "Flags",
        size: 220,
        cell: (c) => {
          const p = c.row.original;
          if (p.reasons.length === 0) return <span className="muted">{p.decision ? p.decision : "none"}</span>;
          return <ReasonChips reasons={p.reasons} />;
        },
      }),
    ],
    [meta.tz, d],
  );

  if (q.error) {
    return (
      <div className="page">
        <p className="error" data-testid="lead-error">
          {q.error.message}. <Link to="/leads">Back to discussion leads</Link>
        </p>
      </div>
    );
  }
  if (!d) return <p className="muted page">Loading…</p>;
  const r = d.lead;

  return (
    <div className="page page-scroll" data-testid="lead-page" data-email={r.person.email}>
      <div className="page-head">
        <p className="muted">
          <Link to="/leads">Discussion leads</Link> ›
        </p>
        <h1 data-testid="lead-page-name">
          <Link to={personPath(r.person.email)}>{r.person.name}</Link>
        </h1>
        <dl className="facts facts-wide" data-testid="lead-summary">
          <dt>Papers</dt>
          <dd>
            {plural(r.load, "paper")} · {r.flagged} flagged · {r.stale} stale
          </dd>
          <dt>Reviews</dt>
          <dd>
            {r.reviews.submitted}/{r.reviews.assigned} submitted · {r.reviews.complete} of {plural(r.load, "paper")} with all {d.reviewsRequired} required
          </dd>
          <dt>Comments</dt>
          <dd>
            {plural(r.comments.total, "comment")} on their papers ({r.comments.discussion} since discussion opened)
          </dd>
          <dt>As lead</dt>
          <dd data-testid="lead-summary-own">
            {r.leadComments.total ? `${plural(r.leadComments.total, "comment")}, ` : ""}
            <LeadCommented r={r} />
          </dd>
        </dl>
        <h2>
          Papers <span className="muted">({d.papers.length})</span>
        </h2>
      </div>
      {d.papers.length ? <SearchActions pids={d.papers.map((p) => p.pid)} base={meta.hotcrpUrl} /> : null}
      <div className="tier-table" style={{ height: 36 + Math.min(Math.max(d.papers.length, 1), 12) * 44 }}>
        <DataTable
          testId="lead-papers"
          data={d.papers}
          columns={columns}
          rowId={(p) => String(p.pid)}
          rowAttrs={(p) => ({ "data-testid": "lead-paper", "data-pid": p.pid })}
          onRowClick={(p) => navigate(`/papers/${p.pid}`)}
          empty="No papers."
        />
      </div>
    </div>
  );
}
