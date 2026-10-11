// The AC table (spec §5b): one row per area chair, alphabetical (not a
// ranking). The load column puts paper count and flagged count side by side
// with a bar scaled to the largest load, so a chair with many papers reads
// differently from one whose few papers are all flagged. Cells far from the
// other ACs on the concerning side carry an outlier mark (outliers.tsx, spec
// §7); a column that is the same for everyone is muted. Clicking a row opens
// the triage list filtered to that AC.

import { createColumnHelper } from "@tanstack/react-table";
import { useMemo } from "react";
import { personPath, useAcs, type AcRow, type MetaResponse } from "../api";
import { LoadBar, Sparkline } from "../components/Charts";
import { DataTable } from "../components/DataTable";
import { formatDays, formatTime, percent, plural } from "../format";
import { cohorts, Marked, withMark, type MetricSpec } from "../outliers";
import { Link, navigate } from "../router";

const col = createColumnHelper<AcRow>();

export const triageForAc = (email: string) => `/?${new URLSearchParams({ ac: email }).toString()}`;

function metaStatus(r: AcRow): string {
  const parts = Object.entries(r.metareview.byStatus)
    .filter(([s]) => !["delivered", "approved", "complete"].includes(s))
    .map(([s, n]) => `${n} ${s}`);
  return parts.length ? parts.join(", ") : "";
}

const activityTotal = (r: AcRow) => r.activity.daily.reduce((a, b) => a + b, 0);

/** Which way is concerning, per column (spec §7 "Outlier marks"). */
export const AC_METRICS = {
  comments: { noun: "comments", cohort: "AC", direction: "higher-better", value: (r) => r.comments, perPaper: (r) => r.load },
  coverage: {
    noun: "coverage",
    cohort: "AC",
    direction: "higher-better",
    value: (r) => (r.coverage.share === null ? null : Math.round(r.coverage.share * 100)),
    format: (v) => `${Math.round(v)}%`,
  },
  first: { noun: "to first post (median)", cohort: "AC", direction: "lower-better", value: (r) => r.timeToFirstPost.medianDays, minGap: 0.5, format: formatDays },
  nudges: { noun: "nudges (proxy)", cohort: "AC", direction: "higher-better", value: (r) => r.nudges.total, perPaper: (r) => r.load },
  stale: { noun: "stale papers", cohort: "AC", direction: "lower-better", value: (r) => r.stale, perPaper: (r) => r.load },
  metareview: {
    noun: "metareviews submitted",
    cohort: "AC",
    direction: "higher-better",
    value: (r) => r.metareview.submitted,
    perPaper: (r) => r.metareview.of,
  },
} satisfies Record<string, MetricSpec<AcRow>>;

export function Acs({ meta }: { meta: MetaResponse }) {
  const acs = useAcs();
  const data = acs.data;
  const maxLoad = data?.maxLoad ?? 0;
  const c = useMemo(() => cohorts(data?.acs ?? [], AC_METRICS), [data]);

  const columns = useMemo(
    () => [
      col.display({
        id: "name",
        header: "Area chair",
        size: 170,
        meta: { kind: "text", value: (r) => r.person.name },
        cell: (x) => (
          <Link to={personPath(x.row.original.person.email)} className="ellipsis person-link" data-testid="ac-name" onClick={(e) => e.stopPropagation()}>
            {x.row.original.person.name}
          </Link>
        ),
      }),
      col.display({
        id: "load",
        header: "Load · flagged",
        size: 220,
        meta: { kind: "numeric", label: "Load", value: (r) => r.load },
        cell: (x) => {
          const r = x.row.original;
          return (
            <span className="load" title={`flagged: ${r.flaggedPids.map((p) => `#${p}`).join(", ") || "none"}`}>
              <span className="num" data-testid="ac-load" data-load={r.load} data-flagged={r.flagged}>
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
        size: 124,
        meta: { kind: "numeric", value: (r) => r.comments },
        cell: (x) => {
          const r = x.row.original;
          return (
            <Marked mark={c.comments.mark(r)} constant={c.comments.constant}>
              <span
                className="num"
                data-testid="ac-comments"
                data-discussion={r.discussionComments}
                title={withMark(`their published comments on their papers: ${r.comments} in all, ${r.discussionComments} since discussion opened`, c.comments.mark(r))}
              >
                {r.comments}
                {r.comments !== r.discussionComments ? <span className="muted"> ({r.discussionComments} since open)</span> : null}
              </span>
            </Marked>
          );
        },
      }),
      col.display({
        id: "coverage",
        header: "Coverage",
        size: 116,
        meta: { kind: "numeric", label: "Coverage %", value: (r) => (r.coverage.share === null ? null : Math.round(r.coverage.share * 100)) },
        cell: (x) => {
          const v = x.row.original.coverage;
          const mark = c.coverage.mark(x.row.original);
          return (
            <Marked mark={mark} constant={c.coverage.constant}>
              <span className="num" data-testid="ac-coverage" title={withMark("papers with a comment from them since discussion opened", mark)}>
                {v.covered}/{v.of} · {percent(v.share)}
              </span>
            </Marked>
          );
        },
      }),
      col.display({
        id: "first",
        header: "First post",
        size: 140,
        meta: { kind: "numeric", label: "First post (days)", value: (r) => r.timeToFirstPost.medianDays },
        cell: (x) => {
          const t = x.row.original.timeToFirstPost;
          const mark = c.first.mark(x.row.original);
          return (
            <Marked mark={mark} constant={c.first.constant}>
              <span
                className="num"
                data-testid="ac-first-post"
                title={withMark(
                  `median over ${plural(t.posted, "paper")} with a post, from discussion opening (or the last review, if later)${t.waiting ? `; ${t.waiting} waiting` : ""}`,
                  mark,
                )}
              >
                {t.medianDays === null ? <span className="muted">no comments yet</span> : formatDays(t.medianDays)}
              </span>
            </Marked>
          );
        },
      }),
      col.display({
        id: "nudges",
        header: "Nudges (proxy)",
        size: 140,
        meta: { kind: "numeric", value: (r) => r.nudges.total },
        cell: (x) => {
          const n = x.row.original.nudges;
          const mark = c.nudges.mark(x.row.original);
          return (
            <Marked mark={mark} constant={c.nudges.constant}>
              <span
                className="num"
                data-testid="ac-nudges"
                title={withMark(
                  `A proxy, not a count of nudges: ${plural(n.mentions, "comment")} @mentioning a reviewer, plus ${plural(n.proxy, "comment")} posted while a reviewer had no comment yet. Email nudges are not visible.`,
                  mark,
                )}
              >
                {n.total}
                {n.mentions ? <span className="muted"> ({n.mentions} @)</span> : null}
              </span>
            </Marked>
          );
        },
      }),
      col.display({
        id: "stale",
        header: "Stale",
        size: 76,
        meta: { kind: "numeric", value: (r) => r.stale },
        cell: (x) => {
          const mark = c.stale.mark(x.row.original);
          return (
            <Marked mark={mark} constant={c.stale.constant}>
              <span className="num" data-testid="ac-stale" title={withMark(x.row.original.stalePids.map((p) => `#${p}`).join(", ") || "none", mark)}>
                {x.row.original.stale}
              </span>
            </Marked>
          );
        },
      }),
      col.display({
        id: "metareview",
        header: "Metareviews",
        size: 130,
        meta: { kind: "numeric", label: "Metareviews submitted", value: (r) => r.metareview.submitted },
        cell: (x) => {
          const r = x.row.original;
          const rest = metaStatus(r);
          const mark = c.metareview.mark(r);
          return (
            <Marked mark={mark} constant={c.metareview.constant}>
              <span className="num" data-testid="ac-metareview" title={withMark(`due ${formatTime(r.metareview.due, meta.tz)}${rest ? `; ${rest}` : ""}`, mark)}>
                {r.metareview.submitted}/{r.metareview.of} submitted
              </span>
            </Marked>
          );
        },
      }),
      col.display({
        id: "activity",
        header: "Activity",
        size: 140,
        meta: { grow: true, kind: "numeric", label: "Activity (total)", value: activityTotal },
        cell: (x) => (
          <>
            <Sparkline daily={x.row.original.activity.daily} start={x.row.original.activity.start} tz={meta.tz} testId="ac-spark" />
          </>
        ),
      }),
    ],
    [maxLoad, meta.tz, c],
  );

  return (
    <div className="page">
      <div className="page-head">
        <h1>Area chairs</h1>
        <p className="muted">
          One row per AC, alphabetical. Comments counts every published comment by the AC on their papers (and, if different, how many came since discussion opened); coverage, first post and nudges count from discussion opening. Nudges are a proxy: AC comments that @mention
          a reviewer, or that were posted while a reviewer had no comment yet. Click a row to see that AC's papers in triage.
        </p>
        <OutlierLegend more="comments, coverage, nudges, metareviews" less="days to first post, stale papers" cohort="ACs" />
      </div>
      {acs.error ? (
        <p className="error">Could not load the AC table: {acs.error.message}</p>
      ) : (
        <DataTable
          testId="ac-table"
          stateKey="ac"
          noun="ACs"
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

/** How to read the marks: which metrics are better high, which low. Not a ranking. */
export function OutlierLegend({ more, less, cohort }: { more: string; less: string; cohort: string }) {
  return (
    <p className="om-legend" data-testid="outlier-legend">
      <span className="om om-mark om-low om-sample" aria-hidden="true">
        <svg className="om-icon" width="9" height="9" viewBox="0 0 10 10">
          <path d="M1 2.5h8L5 8.5z" />
        </svg>
      </span>{" "}
      low where more is better ({more}){" "}
      <span className="om om-mark om-high om-sample" aria-hidden="true">
        <svg className="om-icon" width="9" height="9" viewBox="0 0 10 10">
          <path d="M1 7.5h8L5 1.5z" />
        </svg>
      </span>{" "}
      high where less is better ({less}). Marked against the other {cohort} (quartiles); hover a mark for the numbers.
    </p>
  );
}
