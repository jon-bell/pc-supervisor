// The AC table (spec §5b): one row per area chair, alphabetical (not a
// ranking). The load column puts paper count and flagged count side by side
// with a bar scaled to the largest load, so a chair with many papers reads
// differently from one whose few papers are all flagged. Clicking a row opens
// the triage list filtered to that AC.

import { createColumnHelper } from "@tanstack/react-table";
import { useMemo } from "react";
import { personPath, useAcs, type AcRow, type MetaResponse } from "../api";
import { LoadBar, Sparkline } from "../components/Charts";
import { DataTable } from "../components/DataTable";
import { formatDays, formatTime, percent, plural } from "../format";
import { Link, navigate } from "../router";

const col = createColumnHelper<AcRow>();

export const triageForAc = (email: string) => `/?${new URLSearchParams({ ac: email }).toString()}`;

function metaStatus(r: AcRow): string {
  const parts = Object.entries(r.metareview.byStatus)
    .filter(([s]) => !["delivered", "approved", "complete"].includes(s))
    .map(([s, n]) => `${n} ${s}`);
  return parts.length ? parts.join(", ") : "";
}

export function Acs({ meta }: { meta: MetaResponse }) {
  const acs = useAcs();
  const data = acs.data;
  const maxLoad = data?.maxLoad ?? 0;

  const columns = useMemo(
    () => [
      col.display({
        id: "name",
        header: "Area chair",
        size: 170,
        cell: (c) => (
          <Link to={personPath(c.row.original.person.email)} className="ellipsis" data-testid="ac-name" onClick={(e) => e.stopPropagation()}>
            {c.row.original.person.name}
          </Link>
        ),
      }),
      col.display({
        id: "load",
        header: "Load · flagged",
        size: 230,
        cell: (c) => {
          const r = c.row.original;
          return (
            <span className="load" title={`flagged: ${r.flaggedPids.map((p) => `#${p}`).join(", ") || "none"}`}>
              <span data-testid="ac-load" data-load={r.load} data-flagged={r.flagged}>
                {plural(r.load, "paper")} · {r.flagged} flagged
              </span>
              <LoadBar load={r.load} flagged={r.flagged} max={maxLoad} />
            </span>
          );
        },
      }),
      col.display({
        id: "comments",
        header: "Comments",
        size: 104,
        cell: (c) => {
          const r = c.row.original;
          return (
            <span
              className="num"
              data-testid="ac-comments"
              data-discussion={r.discussionComments}
              title={`their published comments on their papers: ${r.comments} in all, ${r.discussionComments} since discussion opened`}
            >
              {r.comments}
              {r.comments !== r.discussionComments ? <span className="muted"> ({r.discussionComments} since open)</span> : null}
            </span>
          );
        },
      }),
      col.display({
        id: "coverage",
        header: "Coverage",
        size: 100,
        cell: (c) => {
          const v = c.row.original.coverage;
          return (
            <span className="num" data-testid="ac-coverage" title="papers with a comment from them since discussion opened">
              {v.covered}/{v.of} · {percent(v.share)}
            </span>
          );
        },
      }),
      col.display({
        id: "first",
        header: "First post",
        size: 150,
        cell: (c) => {
          const t = c.row.original.timeToFirstPost;
          return (
            <span
              className="num"
              data-testid="ac-first-post"
              title={`median over ${plural(t.posted, "paper")} with a post, from discussion opening (or the last review, if later)${t.waiting ? `; ${t.waiting} waiting` : ""}`}
            >
              {t.medianDays === null ? <span className="muted">no comments yet</span> : formatDays(t.medianDays)}
            </span>
          );
        },
      }),
      col.display({
        id: "nudges",
        header: "Nudges (proxy)",
        size: 150,
        cell: (c) => {
          const n = c.row.original.nudges;
          return (
            <span
              className="num"
              data-testid="ac-nudges"
              title={`A proxy, not a count of nudges: ${plural(n.mentions, "comment")} @mentioning a reviewer, plus ${plural(n.proxy, "comment")} posted while a reviewer had no comment yet. Email nudges are not visible.`}
            >
              {n.total}
              {n.mentions ? <span className="muted"> ({n.mentions} @)</span> : null}
            </span>
          );
        },
      }),
      col.display({
        id: "stale",
        header: "Stale",
        size: 64,
        cell: (c) => (
          <span className="num" data-testid="ac-stale" title={c.row.original.stalePids.map((p) => `#${p}`).join(", ") || "none"}>
            {c.row.original.stale}
          </span>
        ),
      }),
      col.display({
        id: "metareview",
        header: "Metareviews",
        size: 130,
        cell: (c) => {
          const r = c.row.original;
          const rest = metaStatus(r);
          return (
            <span className="num" data-testid="ac-metareview" title={`due ${formatTime(r.metareview.due, meta.tz)}${rest ? `; ${rest}` : ""}`}>
              {r.metareview.submitted}/{r.metareview.of} submitted
            </span>
          );
        },
      }),
      col.display({
        id: "activity",
        header: "Activity",
        size: 140,
        meta: { grow: true },
        cell: (c) => <Sparkline daily={c.row.original.activity.daily} start={c.row.original.activity.start} tz={meta.tz} testId="ac-spark" />,
      }),
    ],
    [maxLoad, meta.tz],
  );

  return (
    <div className="page">
      <div className="page-head">
        <h1>Area chairs</h1>
        <p className="muted">
          One row per AC, alphabetical. Comments counts every published comment by the AC on their papers (and, if different, how many came since discussion opened); coverage, first post and nudges count from discussion opening. Nudges are a proxy: AC comments that @mention
          a reviewer, or that were posted while a reviewer had no comment yet. Click a row to see that AC's papers in triage.
        </p>
      </div>
      {acs.error ? (
        <p className="error">Could not load the AC table: {acs.error.message}</p>
      ) : (
        <DataTable
          testId="ac-table"
          data={data?.acs ?? []}
          columns={columns}
          rowId={(r) => r.person.email}
          rowAttrs={(r) => ({ "data-testid": "ac-row", "data-email": r.person.email })}
          onRowClick={(r) => navigate(triageForAc(r.person.email))}
          empty={data ? "No area chairs in the local store." : "Loading…"}
        />
      )}
    </div>
  );
}
