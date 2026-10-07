// Reviewing progress by tier (spec §10.4 D, PLAN M12): late reviews per tier,
// the reserve dropout view with its escalation states, reserve accountability
// (evidence for a human decision), the junior coaching queue, the optional
// withhold-reviews draft, and participation by tier. Lists are sorted by
// paper or by email, never ranked.

import { useQuery } from "@tanstack/react-query";
import { createColumnHelper } from "@tanstack/react-table";
import type { ReactNode } from "react";
import type { AccountabilityRow, CoachingRow, DropoutRow, DropoutState, TierProgressReport } from "@pcs/server/modules/tier-progress/types";
import { getJson, personPath, type MetaResponse } from "../api";
import { DataTable } from "../components/DataTable";
import { formatDays, formatTime, hotcrp, percent, plural, tierLabel } from "../format";
import { Link } from "../router";

const ROW = 36;
const MAX_ROWS = 10;

export function useTierProgress() {
  return useQuery({ queryKey: ["tier-progress"], queryFn: () => getJson<TierProgressReport>("/api/tier-progress") });
}

export const DROPOUT_LABELS: Readonly<Record<DropoutState, { label: string; chip: string; means: string }>> = {
  late: { label: "Late", chip: "chip-neutral", means: "not submitted after the review deadline; no AC or chair @mention since" },
  pinged: { label: "Pinged", chip: "chip-info", means: "an AC or chair comment @mentioned them since the deadline" },
  "replacement-needed": { label: "Replacement needed", chip: "chip-warn", means: "late by more than PCS_RESERVE_DROPOUT_DAYS, and no one added" },
  replaced: { label: "Replaced", chip: "chip-alert", means: "another reviewer was added on the paper after the deadline" },
};

function Table<T>({ rows, children, testId, rowId, columns, rowAttrs }: {
  rows: readonly T[];
  children?: ReactNode;
  testId: string;
  rowId: (r: T) => string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  columns: any[];
  rowAttrs: (r: T) => Record<string, string | number>;
}) {
  if (rows.length === 0) return <p className="muted none">{children ?? "None."}</p>;
  return (
    <div className="tier-table mod-table" style={{ height: 36 + Math.min(rows.length, MAX_ROWS) * ROW }}>
      <DataTable data={rows} columns={columns} rowHeight={ROW} rowId={rowId} rowAttrs={rowAttrs} testId={testId} />
    </div>
  );
}

const pidLink = (pid: number) => (
  <Link to={`/papers/${pid}`} className="pid">
    #{pid}
  </Link>
);
const personLink = (p: { email: string; name: string }) => <Link to={personPath(p.email)}>{p.name}</Link>;
const pids = (xs: readonly number[]) => (xs.length === 0 ? <span className="muted">–</span> : <span className="pids">{xs.map((p, i) => <span key={p}>{i ? " " : ""}{pidLink(p)}</span>)}</span>);
const cell = (s: string) => (
  <span className="ellipsis" title={s}>
    {s}
  </span>
);

const dcol = createColumnHelper<DropoutRow>();
const DROPOUT_COLUMNS = [
  dcol.accessor("pid", { header: "Paper", size: 70, cell: (c) => pidLink(c.getValue()) }),
  dcol.display({ id: "who", header: "Reviewer", size: 170, cell: (c) => personLink(c.row.original.person) }),
  dcol.accessor("lateDays", { header: "Late", size: 80, cell: (c) => <span className="num">{formatDays(c.getValue())}</span> }),
  dcol.accessor("state", {
    header: "State",
    size: 160,
    cell: (c) => (
      <span className={`chip ${DROPOUT_LABELS[c.getValue()].chip}`} data-testid="dropout-state" data-state={c.getValue()}>
        {DROPOUT_LABELS[c.getValue()].label}
      </span>
    ),
  }),
  dcol.accessor("reason", { header: "Why", size: 300, meta: { grow: true }, cell: (c) => cell(c.getValue()) }),
];

const acol = createColumnHelper<AccountabilityRow>();
const ACCOUNT_COLUMNS = [
  acol.display({ id: "who", header: "Reserve reviewer", size: 170, cell: (c) => personLink(c.row.original.person) }),
  acol.display({ id: "own", header: "Own papers", size: 110, cell: (c) => pids(c.row.original.ownPapers.map((p) => p.pid)) }),
  acol.display({ id: "sub", header: "Submitted", size: 90, cell: (c) => <span className="num">{c.row.original.submitted}/{c.row.original.assigned}</span> }),
  acol.display({
    id: "late",
    header: "Late",
    size: 120,
    cell: (c) => (
      <span className="num" data-testid="acct-late">
        {c.row.original.lateOutstanding} open · {c.row.original.submittedLate} after
      </span>
    ),
  }),
  acol.accessor("thin", { header: "Thin", size: 60, cell: (c) => <span className="num">{c.getValue()}</span> }),
  acol.display({ id: "rated", header: "Rated short/vague", size: 130, cell: (c) => <span className="num">{c.row.original.ratedShort}/{c.row.original.ratedVague}</span> }),
  acol.accessor("summary", { header: "Summary", size: 300, meta: { grow: true }, cell: (c) => cell(c.getValue()) }),
];

function coachColumns(base: string) {
  const ccol = createColumnHelper<CoachingRow>();
  return [
    ccol.accessor("pid", { header: "Paper", size: 70, cell: (c) => pidLink(c.getValue()) }),
    ccol.display({ id: "who", header: "Reviewer", size: 170, cell: (c) => personLink(c.row.original.person) }),
    ccol.accessor("words", { header: "Words", size: 70, cell: (c) => <span className="num">{c.getValue()}</span> }),
    ccol.accessor("reason", { header: "Why", size: 260, meta: { grow: true }, cell: (c) => cell(c.getValue()) }),
    ccol.display({
      id: "link",
      header: "",
      size: 120,
      cell: (c) => (
        <a href={hotcrp.review(base, c.row.original.pid, c.row.original.ordinal, c.row.original.rid)} target="_blank" rel="noreferrer noopener" className="ext" data-testid="coach-link">
          Open in HotCRP ↗
        </a>
      ),
    }),
  ];
}

export function TierProgress({ meta }: { meta: MetaResponse }) {
  const q = useTierProgress();
  const r = q.data;
  const key = (x: { pid: number; person: { email: string } }) => `${x.person.email}@${x.pid}`;
  return (
    <div className="page page-scroll" data-testid="tier-progress">
      <div className="page-head">
        <h1>Reviewing progress by tier</h1>
        <p className="muted">
          From the last sync: outstanding and late reviews per tier, late reserve reviews and how far they have escalated, and reviews that may need coaching.
          {r ? ` Review deadline ${formatTime(r.reviewDue, meta.tz)}${r.deadlinePassed ? " (passed)" : ""}.` : null}
        </p>
      </div>
      {q.error ? <p className="error">Could not load reviewing progress: {q.error.message}</p> : null}
      {!r && !q.error ? <p className="muted">Loading…</p> : null}
      {r ? (
        <>
          <section className="mod-section">
            <h2>Outstanding and late, by tier</h2>
            <table className="mini" data-testid="tier-table">
              <thead>
                <tr>
                  <th>Tier</th>
                  <th>Reviewers</th>
                  <th>Submitted</th>
                  <th>Outstanding</th>
                  <th>Late</th>
                  <th>Submitted late</th>
                  <th>Assigned after deadline</th>
                </tr>
              </thead>
              <tbody>
                {r.tiers.map((t) => (
                  <tr key={t.tier} data-testid="tier-row" data-tier={t.tier} title={t.reason}>
                    <td>{tierLabel(t.tier)}</td>
                    <td className="num">{t.reviewers}</td>
                    <td className="num">
                      {t.submitted}/{t.assigned}
                    </td>
                    <td className="num" data-testid="tier-outstanding">
                      {t.outstanding}
                    </td>
                    <td className="num" data-testid="tier-late">
                      {t.late}
                    </td>
                    <td className="num">{t.submittedLate}</td>
                    <td className="num">{t.assignedAfterDue}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="mod-section">
            <h2>
              Reserve dropout <span className="muted">({r.dropout.rows.length})</span>
            </h2>
            <p className="muted bar">
              Late reviews by {r.dropout.reserveTiers.map(tierLabel).join(", ") || "(no reserve tiers)"} reviewers. Counts:{" "}
              {(Object.keys(DROPOUT_LABELS) as DropoutState[]).map((s) => `${DROPOUT_LABELS[s].label.toLowerCase()} ${r.dropout.counts[s]}`).join(", ")}.
            </p>
            <ul className="defs">
              {(Object.keys(DROPOUT_LABELS) as DropoutState[]).map((s) => (
                <li key={s}>
                  <span className={`chip ${DROPOUT_LABELS[s].chip}`}>{DROPOUT_LABELS[s].label}</span> {DROPOUT_LABELS[s].means}
                  {s === "replacement-needed" ? ` (${r.dropout.dropoutDays} days)` : ""}.
                </li>
              ))}
            </ul>
            <Table rows={r.dropout.rows} columns={DROPOUT_COLUMNS} testId="dropout-table" rowId={key} rowAttrs={(d) => ({ "data-testid": "dropout-row", "data-key": key(d) })}>
              No late reserve reviews.
            </Table>
          </section>

          <section className="mod-section">
            <h2>Reserve accountability</h2>
            <p className="muted bar" data-testid="accountability-note">
              {r.accountability.note} Each reserve reviewer's own submissions next to their review record.
            </p>
            <Table
              rows={r.accountability.rows}
              columns={ACCOUNT_COLUMNS}
              testId="accountability-table"
              rowId={(a) => a.person.email}
              rowAttrs={(a) => ({ "data-testid": "accountability-row", "data-email": a.person.email })}
            >
              No reserve reviewers with reviews.
            </Table>
          </section>

          <section className="mod-section">
            <h2>
              Coaching queue <span className="muted">({r.coaching.rows.length})</span>
            </h2>
            <p className="muted bar">
              {r.coaching.tiers.map(tierLabel).join(", ") || "(no tiers)"} reviews under {r.coaching.minWords} words, or rated short or vague. Coaching happens in HotCRP, as comments.
            </p>
            <Table rows={r.coaching.rows} columns={coachColumns(meta.hotcrpUrl)} testId="coaching-table" rowId={key} rowAttrs={(c) => ({ "data-testid": "coaching-row", "data-key": key(c) })}>
              No reviews in the coaching queue.
            </Table>
          </section>

          <section className="mod-section" data-testid="withhold">
            <h2>Withholding reviews from late reserve reviewers</h2>
            <p className="muted bar">{r.withhold.note}</p>
            {r.withhold.enabled ? (
              <>
                <ul className="defs">
                  {r.withhold.rows.map((w) => (
                    <li key={w.person.email} data-testid="withhold-row">
                      {personLink(w.person)}: {w.reason}
                    </li>
                  ))}
                </ul>
                {r.withhold.csv ? (
                  <>
                    <h3>Draft HotCRP bulk-assignment CSV (not applied)</h3>
                    <pre className="draft" data-testid="withhold-csv">
                      {r.withhold.csv}
                    </pre>
                  </>
                ) : (
                  <p className="muted">No papers to tag.</p>
                )}
              </>
            ) : null}
          </section>

          <section className="mod-section">
            <h2>Discussion participation, by tier</h2>
            <table className="mini" data-testid="participation-table">
              <thead>
                <tr>
                  <th>Tier</th>
                  <th>Reviewers who commented</th>
                  <th>Comments</th>
                  <th>Papers with a comment since discussion opened</th>
                </tr>
              </thead>
              <tbody>
                {r.participation.rows.map((p) => (
                  <tr key={p.tier} data-testid="participation-row" data-tier={p.tier} title={p.reason}>
                    <td>{tierLabel(p.tier)}</td>
                    <td className="num">
                      {p.commenters}/{p.reviewers}
                    </td>
                    <td className="num">{p.comments}</td>
                    <td className="num">
                      {r.participation.discussionOpened ? `${p.discussionCommented}/${plural(p.discussionPapers, "paper")} · ${percent(p.share)}` : "not open yet"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      ) : null}
    </div>
  );
}
