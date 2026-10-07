// Early reject (spec §10.4 E, PLAN M12): candidates as of the window's open
// (provisional before it), each with its discussion signals; the window
// outcome (bumped, not bumped, reviewers with no response) so far or at close;
// and the drafted HotCRP Mail-tool search. The app never sends mail.

import { useQuery } from "@tanstack/react-query";
import { createColumnHelper } from "@tanstack/react-table";
import type { Candidate, EarlyRejectReport, NoResponseRow } from "@pcs/server/modules/early-reject/types";
import { getJson, personPath, type MetaResponse } from "../api";
import { DataTable } from "../components/DataTable";
import { formatTime } from "../format";
import { Link } from "../router";

const ROW = 36;
const MAX_ROWS = 10;

export function useEarlyReject() {
  return useQuery({ queryKey: ["early-reject"], queryFn: () => getJson<EarlyRejectReport>("/api/early-reject") });
}

const STATUS_LABEL: Record<EarlyRejectReport["status"], string> = {
  unconfigured: "not configured",
  before: "not open yet",
  open: "open",
  closed: "closed",
};

const pidLink = (pid: number) => (
  <Link to={`/papers/${pid}`} className="pid">
    #{pid}
  </Link>
);

function candidateColumns(withOutcome: boolean) {
  const col = createColumnHelper<Candidate>();
  return [
    col.accessor("pid", { header: "Paper", size: 70, cell: (c) => pidLink(c.getValue()) }),
    col.accessor("title", { header: "Title", size: 220, meta: { grow: true }, cell: (c) => <span className="ellipsis" title={c.getValue()}>{c.getValue()}</span> }),
    col.display({
      id: "merits",
      header: withOutcome ? "Merits (open → now)" : "Merits",
      size: 150,
      cell: (c) => (
        <span className="num" data-testid="cand-merits">
          {c.row.original.meritsAtOpen.join("/")}
          {withOutcome && c.row.original.meritsNow ? ` → ${c.row.original.meritsNow.join("/")}` : ""}
        </span>
      ),
    }),
    col.display({
      id: "signals",
      header: "Discussion signals",
      size: 260,
      cell: (c) => {
        const s = c.row.original.signals;
        const t = `${s.comments} comments (${s.acComments} by ACs, ${s.windowComments} in the window); ${s.outstandingReviews} reviews outstanding${s.newReviewsInWindow ? `; ${s.newReviewsInWindow} new in the window` : ""}`;
        return (
          <span className="ellipsis" title={t}>
            {t}
          </span>
        );
      },
    }),
    ...(withOutcome
      ? [
          col.accessor("bumped", {
            header: "Outcome",
            size: 110,
            cell: (c) => (
              <span className={`chip ${c.getValue() ? "chip-info" : "chip-neutral"}`} data-testid="cand-outcome" data-bumped={String(c.getValue())}>
                {c.getValue() ? "bumped" : "not bumped"}
              </span>
            ),
          }),
        ]
      : []),
  ];
}

const ncol = createColumnHelper<NoResponseRow>();
const NO_RESPONSE_COLUMNS = [
  ncol.accessor("pid", { header: "Paper", size: 70, cell: (c) => pidLink(c.getValue()) }),
  ncol.display({ id: "who", header: "Reviewer", size: 180, cell: (c) => <Link to={personPath(c.row.original.person.email)}>{c.row.original.person.name}</Link> }),
  ncol.accessor("reason", { header: "Detail", size: 320, meta: { grow: true }, cell: (c) => <span className="ellipsis" title={c.getValue()}>{c.getValue()}</span> }),
];

export function EarlyReject({ meta }: { meta: MetaResponse }) {
  const q = useEarlyReject();
  const r = q.data;
  const tz = meta.tz;
  const withOutcome = r?.outcomeAt !== null && r?.outcomeAt !== undefined;
  const atClose = r !== undefined && r.outcomeAt !== null && r.outcomeAt === r.close;
  return (
    <div className="page page-scroll" data-testid="early-reject">
      <div className="page-head">
        <h1>Early reject</h1>
        {r ? (
          <p className="muted" data-testid="er-window" data-status={r.status}>
            {r.status === "unconfigured"
              ? "Set PCS_PHASE_EARLYREJECT_OPEN (and _CLOSE, or PCS_EARLYREJECT_WINDOW_H) to track an early-reject window."
              : `Window ${formatTime(r.open!, tz)} – ${formatTime(r.close!, tz)}${r.closeSource === "window-hours" ? " (open + PCS_EARLYREJECT_WINDOW_H)" : ""}: ${STATUS_LABEL[r.status]}.`}{" "}
            {r.status !== "unconfigured" ? `Band: ${r.definition}.` : null}
          </p>
        ) : null}
      </div>
      {q.error ? <p className="error">Could not load early reject: {q.error.message}</p> : null}
      {!r && !q.error ? <p className="muted">Loading…</p> : null}
      {r && r.status !== "unconfigured" ? (
        <>
          <section className="mod-section">
            <h2>
              Candidates <span className="muted">({r.candidates.length})</span>
            </h2>
            <p className="muted bar">
              {r.status === "before" ? "Provisional: computed as of now; the list is fixed when the window opens." : `As of the window's open (${formatTime(r.candidatesAt!, tz)}), from the sync history.`}
            </p>
            {r.candidates.length === 0 ? (
              <p className="muted none">No paper has every merit in the band.</p>
            ) : (
              <div className="tier-table mod-table" style={{ height: 36 + Math.min(r.candidates.length, MAX_ROWS) * ROW }}>
                <DataTable
                  data={r.candidates}
                  columns={candidateColumns(withOutcome)}
                  rowHeight={ROW}
                  rowId={(c) => String(c.pid)}
                  rowAttrs={(c) => ({ "data-testid": "candidate-row", "data-pid": c.pid })}
                  testId="candidate-table"
                />
              </div>
            )}
          </section>

          {withOutcome ? (
            <section className="mod-section" data-testid="er-outcome">
              <h2>{atClose ? "At close" : `So far (as of ${formatTime(r.outcomeAt!, tz)})`}</h2>
              <p>
                Bumped (a merit raised in the window): <span data-testid="er-bumped">{r.bumped.length ? r.bumped.map((p) => `#${p}`).join(" ") : "none"}</span>. Not bumped:{" "}
                <span data-testid="er-not-bumped">{r.notBumped.length ? r.notBumped.map((p) => `#${p}`).join(" ") : "none"}</span>.
              </p>
              <h3>
                Reviewers with no response <span className="muted">({r.noResponse.length})</span>
              </h3>
              <p className="muted bar">No merit change and no comment on the paper during the window.</p>
              {r.noResponse.length === 0 ? (
                <p className="muted none">Every reviewer of a candidate responded.</p>
              ) : (
                <div className="tier-table mod-table" style={{ height: 36 + Math.min(r.noResponse.length, MAX_ROWS) * ROW }}>
                  <DataTable
                    data={r.noResponse}
                    columns={NO_RESPONSE_COLUMNS}
                    rowHeight={ROW}
                    rowId={(n) => `${n.person.email}@${n.pid}`}
                    rowAttrs={(n) => ({ "data-testid": "no-response-row", "data-key": `${n.person.email}@${n.pid}` })}
                  />
                </div>
              )}
            </section>
          ) : null}

          {r.mail ? (
            <section className="mod-section" data-testid="er-mail">
              <h2>Mail-tool draft (not sent)</h2>
              <p className="muted bar">
                Paste into HotCRP&apos;s Mail tool, recipients &ldquo;Reviewers with complete reviews&rdquo;:{" "}
                <a href={`${meta.hotcrpUrl}${r.mail.mailPath}`} target="_blank" rel="noreferrer noopener" className="ext">
                  open the Mail tool with this search ↗
                </a>
              </p>
              <dl className="facts facts-wide">
                <dt>Search</dt>
                <dd>
                  <code data-testid="er-search">{r.mail.search}</code>
                </dd>
                <dt>Subject</dt>
                <dd>{r.mail.subject}</dd>
              </dl>
              <pre className="draft">{r.mail.body}</pre>
            </section>
          ) : null}
          {r.notes.map((n) => (
            <p key={n} className="muted mod-note">
              {n}
            </p>
          ))}
        </>
      ) : null}
    </div>
  );
}
