// The person page (spec §5a): every paper they review or chair, their score
// there, their last comment, and their open pings, plus a short summary.
// Wording follows spec §7: it describes what HotCRP shows, never the person.

import { createColumnHelper } from "@tanstack/react-table";
import { useMemo } from "react";
import { usePerson, type MetaResponse, type PersonPaper, type PersonResponse } from "../api";
import { SearchActions } from "../components/Actions";
import { Chip } from "../components/Chip";
import { DataTable } from "../components/DataTable";
import { AbsTime } from "../components/Time";
import { formatRatings, NEGATIVE_FLAGS, pickRatings } from "@pcs/server/ratings";
import { formatDays, percent, plural, ruleLabel, tierLabel } from "../format";
import { Link, navigate } from "../router";
import { triageForAc } from "./Acs";

const col = createColumnHelper<PersonPaper>();

const OUTLIER_TEXT: Readonly<Record<string, string>> = {
  silentOnSplit: "No comments yet on split papers",
  unansweredPings: "Unanswered pings",
  late: "Reviews not submitted",
  thin: "Short or flagged reviews",
  flagged: "Repeatedly flagged reviews",
};

function Flags({ p }: { p: PersonPaper }) {
  const f = p.flags;
  return (
    <span className="chips chips-wrap" data-testid="person-flags">
      {f.silentOnSplit ? <Chip tone="warn" testId="flag-silent">no comment yet (split)</Chip> : null}
      {f.unansweredPing ? <Chip tone="warn" testId="flag-ping">ping unanswered</Chip> : null}
      {f.outstanding ? <Chip tone="alert" testId="flag-outstanding">review not submitted</Chip> : null}
      {f.thin ? <Chip tone="info" testId="flag-thin">short review</Chip> : null}
      {f.ratingFlagged && p.review?.ratings ? (
        <Chip tone="info" testId="flag-rated" title="HotCRP review ratings on their review: raters per flag">
          rated {formatRatings(pickRatings(p.review.ratings, NEGATIVE_FLAGS))}
        </Chip>
      ) : null}
    </span>
  );
}

function Summary({ d }: { d: PersonResponse }) {
  const r = d.reviewer;
  const a = d.ac;
  return (
    <dl className="facts facts-wide" data-testid="person-summary">
      {r ? (
        <>
          <dt>Reviews</dt>
          <dd data-testid="sum-reviews">
            {r.submitted} of {r.assigned} submitted
            {r.late ? <span className="warn-text"> · {plural(r.outstanding.length, "review")} not submitted after the deadline</span> : null}
          </dd>
          <dt>Discussion</dt>
          <dd data-testid="sum-participation">
            commented on {r.participation.commented} of {plural(r.participation.papers, "paper")} since discussion opened ({percent(r.participation.share)})
          </dd>
          <dt>Replies</dt>
          <dd>
            {r.responsiveness.medianDays === null
              ? "no answered pings"
              : `median ${formatDays(r.responsiveness.medianDays)} to reply (${plural(r.responsiveness.answered, "ping")} answered)`}
          </dd>
          <dt>Depth</dt>
          <dd>
            median {r.depth.medianWords ?? "–"} words vs PC {r.depth.pcMedianWords ?? "–"}
            {r.depth.thin ? ` · ${r.depth.thin} under the word minimum` : ""}
            {r.depth.ratedThin ? ` · ${r.depth.ratedThin} flagged short/vague` : ""}
          </dd>
          {r.ratings ? (
            <>
              <dt>Rating flags</dt>
              <dd data-testid="sum-ratings">
                {r.ratings.negative + r.ratings.good === 0
                  ? "no rating flags on their reviews"
                  : `${formatRatings(r.ratings.received) || "none"} received` +
                    (r.ratings.negativePids.length ? ` · flags other than good on ${plural(r.ratings.negativePids.length, "paper")}` : "")}
              </dd>
            </>
          ) : null}
          <dt>Movement</dt>
          <dd>{r.movement.reviews ? `score changes on ${r.movement.pids.map((p) => `#${p}`).join(", ")}` : "no score changes since discussion opened"}</dd>
        </>
      ) : null}
      {a ? (
        <>
          <dt>As AC</dt>
          <dd data-testid="sum-ac">
            {plural(a.load, "paper")} · {a.flagged} flagged · {plural(a.comments, "comment")} ({a.discussionComments} since discussion opened) ·{" "}
            <Link to={triageForAc(d.person.email)}>see in triage</Link>
          </dd>
        </>
      ) : null}
    </dl>
  );
}

export function Person({ meta, email }: { meta: MetaResponse; email: string }) {
  const q = usePerson(email);
  const d = q.data;

  const columns = useMemo(
    () => [
      col.accessor("pid", { header: "#", size: 52, cell: (c) => <span className="pid">#{c.getValue()}</span> }),
      col.accessor("title", {
        header: "Title",
        size: 180,
        meta: { grow: true },
        cell: (c) => (
          <span className="title" title={c.getValue()}>
            {c.getValue()}
          </span>
        ),
      }),
      col.accessor("role", { header: "Role", size: 90, cell: (c) => <span data-testid="paper-role">{c.getValue()}</span> }),
      col.display({
        id: "score",
        header: "Their review",
        size: 140,
        cell: (c) => {
          const r = c.row.original.review;
          if (!r) return <span className="muted">none</span>;
          return (
            <span data-testid="their-score" title={plural(r.wordCount, "word")}>
              {r.submitted ? (r.merit !== null ? `merit ${r.merit}` : "submitted") : <span className="warn-text">{r.status}</span>}
              {r.submitted && r.expertise !== null ? <span className="muted"> · exp {r.expertise}</span> : null}
            </span>
          );
        },
      }),
      col.accessor("merits", { header: "Merits", size: 80, cell: (c) => <span className="scores">{c.getValue().join("/") || "–"}</span> }),
      col.display({
        id: "last",
        header: "Their last comment",
        size: 200,
        cell: (c) => {
          const p = c.row.original;
          const l = p.lastComment;
          if (!l) return <span className="muted" data-testid="last-comment">no comments yet</span>;
          return (
            <span className="ellipsis" data-testid="last-comment" title={l.excerpt}>
              <AbsTime ms={l.time} tz={meta.tz} approximate={l.approximate} /> · {plural(l.wordCount, "word")}
              {p.comments > 1 ? <span className="muted"> · {p.comments} in all</span> : null}
            </span>
          );
        },
      }),
      col.display({
        id: "rules",
        header: "Paper flags",
        size: 150,
        cell: (c) => (
          <span className="ellipsis" title={c.row.original.rules.map(ruleLabel).join(", ")}>
            {c.row.original.rules.map(ruleLabel).join(", ") || <span className="muted">{c.row.original.decision ? "decided" : "none"}</span>}
          </span>
        ),
      }),
      col.display({ id: "flags", header: "Their part", size: 300, cell: (c) => <Flags p={c.row.original} /> }),
    ],
    [meta.tz],
  );

  if (q.error) {
    return (
      <div className="page">
        <p className="error" data-testid="person-error">
          {q.error.message}. <Link to="/reviewers">Back to reviewers</Link>
        </p>
      </div>
    );
  }
  if (!d) return <p className="muted page">Loading…</p>;

  return (
    <div className="page page-scroll" data-testid="person-page" data-email={d.person.email}>
      <div className="page-head">
        <h1 data-testid="person-name">{d.person.name}</h1>
        <p className="muted">
          {meta.tiersConfigured ? (
            <>
              <span data-testid="person-tier">{tierLabel(d.person.tier)}</span> ·{" "}
            </>
          ) : null}
          {d.person.email}
          {d.ac ? " · area chair" : ""}
        </p>
        {d.outliers.length ? (
          <p className="chips chips-wrap" data-testid="person-outliers">
            {d.outliers.map((o) => (
              <Chip key={o} tone="warn" testId="person-outlier">
                {OUTLIER_TEXT[o] ?? o}
              </Chip>
            ))}
          </p>
        ) : null}
        <Summary d={d} />
        <h2>Open pings</h2>
        {d.openPings.length === 0 ? (
          <p className="muted" data-testid="no-pings">
            No open pings.
          </p>
        ) : (
          <ul className="pings" data-testid="open-pings">
            {d.openPings.map((p) => (
              <li key={p.pid} data-testid="open-ping" data-pid={p.pid}>
                <Link to={`/papers/${p.pid}`}>#{p.pid}</Link> {p.title}: pinged since <AbsTime ms={p.since} tz={meta.tz} />
                {p.mentionedAt !== null ? (
                  <>
                    {" "}
                    (@mentioned <AbsTime ms={p.mentionedAt} tz={meta.tz} />)
                  </>
                ) : (
                  " (AC comment)"
                )}
                ,{" "}
                <strong data-testid="ping-age">unanswered for {formatDays(p.ageDays)}</strong>
                {p.pings > 1 ? ` (${p.pings} pings)` : ""}
                {p.overThreshold ? <span className="muted"> · over the {d.pingDays}-day bar</span> : null}
              </li>
            ))}
          </ul>
        )}
        <h2>
          Papers <span className="muted">({d.papers.length})</span>
        </h2>
      </div>
      {d.papers.length ? <SearchActions pids={d.papers.map((p) => p.pid)} base={meta.hotcrpUrl} /> : null}
      <div className="tier-table" style={{ height: 36 + Math.min(Math.max(d.papers.length, 1), 12) * 44 }}>
      <DataTable
        testId="person-papers"
        data={d.papers}
        columns={columns}
        rowId={(r) => `${r.role}-${r.pid}`}
        rowAttrs={(r) => ({ "data-testid": "person-paper", "data-pid": r.pid })}
        onRowClick={(r) => navigate(`/papers/${r.pid}`)}
        empty="No papers."
      />
      </div>
    </div>
  );
}
