// Process report (spec §10.4 G, PLAN M13): aggregates by tier (depth,
// timeliness, merit distribution, review ratings, score agreement), reserve
// activation and dropout, early-reject yield, quick/desk-reject counts and
// appeals, the do-not-invite carry-forward, and the pseudonymous export.
// Aggregates only: no people are listed, and groups smaller than
// PCS_REPORT_MIN_CELL show "fewer than N" instead of numbers. Downloads come
// from the local server to this browser; nothing is uploaded anywhere.

import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { Cell, ProcessReport } from "@pcs/server/modules/report/types";
import { getJson, type MetaResponse } from "../api";
import { Histogram } from "../components/Charts";
import { formatDate, formatTime, PHASE_LABELS, percent, tierLabel } from "../format";

export function useReport() {
  return useQuery({ queryKey: ["report"], queryFn: () => getJson<ProcessReport>("/api/report") });
}

const num = (v: number | null | undefined, digits = 0) => (v === null || v === undefined ? "–" : digits ? v.toFixed(digits) : String(v));

function Row({ cell, tier, minCell, children, testId }: { cell: Cell; tier: string; minCell: number; children: ReactNode; testId: string }) {
  return (
    <tr data-testid={testId} data-tier={tier} data-suppressed={cell.suppressed ? "1" : "0"}>
      <th scope="row">{tierLabel(tier)}</th>
      {cell.suppressed ? (
        <td colSpan={99} className="muted" data-testid="suppressed" title={`Numbers withheld: fewer than PCS_REPORT_MIN_CELL=${minCell} people`}>
          fewer than {minCell} people; withheld
        </td>
      ) : (
        <>
          <td className="num">{cell.people}</td>
          {children}
        </>
      )}
    </tr>
  );
}

function Section({ title, children, testId, intro }: { title: string; children: ReactNode; testId: string; intro?: ReactNode }) {
  return (
    <section className="ov-section" data-testid={testId}>
      <h2>{title}</h2>
      {intro ? <p className="muted">{intro}</p> : null}
      {children}
    </section>
  );
}

function Kv({ rows, testId }: { rows: [string, ReactNode][]; testId?: string }) {
  return (
    <table className="mini" data-testid={testId}>
      <tbody>
        {rows.map(([k, v]) => (
          <tr key={k}>
            <th scope="row">{k}</th>
            <td className="num">{v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function Report({ meta }: { meta: MetaResponse }) {
  const q = useReport();
  const r = q.data;
  if (q.error) return <p className="error page">Could not load the report: {q.error.message}</p>;
  if (!r) return <p className="muted page">Loading…</p>;
  const m = r.minCell;
  const t = r.totals;
  const rs = r.reserve;
  const er = r.earlyReject;
  const qr = r.quickReject;

  return (
    <div className="page page-scroll" data-testid="report">
      <div className="page-head">
        <h1>Process report</h1>
        <p className="muted">
          <span className={`chip ${r.final ? "chip-info" : "chip-neutral"}`} data-testid="report-status" data-final={r.final ? "1" : "0"}>
            {r.final ? "Final" : "Provisional"}
          </span>{" "}
          as of <span className="volatile">{formatTime(r.now, meta.tz)}</span> · phase {PHASE_LABELS[r.phase] ?? r.phase} · aggregates only; groups of fewer than {m} people are withheld
        </p>
        {r.notes.length ? (
          <ul className="notes muted" data-testid="report-notes">
            {r.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        ) : null}
      </div>

      <section className="ov-section">
        <h2>Totals</h2>
        <div className="stats" data-testid="report-totals">
          {(
            [
              ["papers", t.papers],
              ["decided", t.decided],
              ["accept side", t.accepted],
              ["reject side", t.rejected],
              ["reviewer reviews", t.reviewerReviews],
              ["submitted", t.submitted],
            ] as const
          ).map(([label, v]) => (
            <div className="stat" key={label} data-testid={`total-${label.replace(/ /g, "-")}`}>
              <div className="stat-value">{v}</div>
              <div className="stat-label">{label}</div>
            </div>
          ))}
        </div>
      </section>

      <Section title="Review depth by tier" testId="report-depth" intro={`Words in submitted reviewer reviews. The floor is PCS_THRESH_MIN_WORDS=${r.depth.minWords}.`}>
        <table className="mini">
          <thead>
            <tr>
              <th>Tier</th>
              <th>Reviewers</th>
              <th>Reviews</th>
              <th>Median</th>
              <th>p25–p75</th>
              <th>Mean</th>
              <th>Under floor</th>
            </tr>
          </thead>
          <tbody>
            {r.depth.rows.map((d) => (
              <Row key={d.tier} cell={d} tier={d.tier} minCell={m} testId="depth-row">
                <td className="num">{num(d.reviews)}</td>
                <td className="num" data-testid="depth-median">{num(d.median)}</td>
                <td className="num">
                  {num(d.p25)}–{num(d.p75)}
                </td>
                <td className="num">{num(d.mean, 1)}</td>
                <td className="num">{num(d.underFloor)}</td>
              </Row>
            ))}
          </tbody>
        </table>
        <div className="ov-grid">
          {r.depth.rows
            .filter((d) => d.bins)
            .map((d) => (
              <figure key={d.tier} className="small-multiple">
                <figcaption>{tierLabel(d.tier)}: words per review</figcaption>
                <Histogram
                  testId={`depth-histogram-${d.tier}`}
                  ariaLabel={`${tierLabel(d.tier)}: submitted reviews by word count`}
                  bins={d.bins!.map((b) => ({ label: b.label, value: b.count, highlight: b.from < r.depth.minWords, title: `${b.label} words: ${b.count} reviews` }))}
                />
              </figure>
            ))}
        </div>
      </Section>

      <Section title="Timeliness by tier" testId="report-timeliness" intro={`First submission vs the review deadline (${formatDate(r.timeliness.reviewDue, meta.tz)}). Replacements assigned after the deadline are never late.`}>
        <table className="mini">
          <thead>
            <tr>
              <th>Tier</th>
              <th>Reviewers</th>
              <th>Assigned</th>
              <th>On time</th>
              <th>Late</th>
              <th>Not submitted</th>
              <th>Assigned after deadline</th>
              <th>Median vs deadline</th>
            </tr>
          </thead>
          <tbody>
            {r.timeliness.rows.map((d) => (
              <Row key={d.tier} cell={d} tier={d.tier} minCell={m} testId="timeliness-row">
                <td className="num">{num(d.assigned)}</td>
                <td className="num">
                  {num(d.onTime)} ({percent(d.onTimeShare)})
                </td>
                <td className="num">{num(d.late)}</td>
                <td className="num">{num(d.notSubmitted)}</td>
                <td className="num">{num(d.assignedAfterDue)}</td>
                <td className="num">{d.medianDaysVsDue === null ? "–" : `${d.medianDaysVsDue > 0 ? "+" : ""}${d.medianDaysVsDue.toFixed(1)} d`}</td>
              </Row>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title="Merit distribution by tier" testId="report-merits" intro={`Submitted reviewer merits (${r.merits.field}); accept side from ${r.merits.acceptMin}.`}>
        <div className="ov-grid">
          {r.merits.rows.map((d) =>
            d.bins ? (
              <figure key={d.tier} className="small-multiple" data-testid="merit-row" data-tier={d.tier}>
                <figcaption>
                  {tierLabel(d.tier)}: {d.reviews} merits, mean {num(d.mean, 2)}
                </figcaption>
                <Histogram
                  testId={`merit-histogram-${d.tier}`}
                  ariaLabel={`${tierLabel(d.tier)}: merit distribution`}
                  bins={d.bins.map((b) => ({ label: b.label, value: b.count, highlight: b.from >= r.merits.acceptMin, title: `merit ${b.label}: ${b.count}` }))}
                />
              </figure>
            ) : (
              <p key={d.tier} className="muted" data-testid="merit-row" data-tier={d.tier} data-suppressed="1">
                {tierLabel(d.tier)}: fewer than {m} people; withheld
              </p>
            ),
          )}
        </div>
      </Section>

      <Section title="Review ratings by tier" testId="report-ratings" intro="Reviews carrying each HotCRP review rating (a review counts once per rating).">
        <table className="mini">
          <thead>
            <tr>
              <th>Tier</th>
              <th>Reviewers</th>
              <th>Reviews</th>
              <th>Rated</th>
              {r.ratings.names.map((n) => (
                <th key={n}>{n}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {r.ratings.rows.map((d) => (
              <Row key={d.tier} cell={d} tier={d.tier} minCell={m} testId="rating-row">
                <td className="num">{num(d.reviews)}</td>
                <td className="num">{num(d.rated)}</td>
                {r.ratings.names.map((n) => (
                  <td key={n} className="num">
                    {num(d.counts?.[n])}
                  </td>
                ))}
              </Row>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title="Score agreement by tier" testId="report-agreement" intro="Mean absolute deviation of a merit from its paper's mean (papers with 2+ merits), and how often merits sit on the final decision's side.">
        <table className="mini">
          <thead>
            <tr>
              <th>Tier</th>
              <th>Reviewers</th>
              <th>Merits</th>
              <th>Mean |dev|</th>
              <th>On decided papers</th>
              <th>On the decision's side</th>
            </tr>
          </thead>
          <tbody>
            {r.agreement.rows.map((d) => (
              <Row key={d.tier} cell={d} tier={d.tier} minCell={m} testId="agreement-row">
                <td className="num">{num(d.reviews)}</td>
                <td className="num" data-testid="agreement-mad">{num(d.meanAbsDev, 2)}</td>
                <td className="num">{num(d.decided)}</td>
                <td className="num">
                  {num(d.onDecisionSide)} ({percent(d.share)})
                </td>
              </Row>
            ))}
          </tbody>
        </table>
      </Section>

      <div className="ov-grid">
        <Section title="Reserve activation and dropout" testId="report-reserve" intro={`Tiers: ${rs.tiers.join(", ") || "none"}.`}>
          {rs.suppressed ? (
            <p className="muted" data-testid="suppressed">
              Fewer than {m} reserve reviewers; withheld.
            </p>
          ) : (
            <Kv
              testId="reserve-kv"
              rows={[
                ["active / pool", `${num(rs.active)} / ${num(rs.pool)}`],
                ["activation", percent(rs.activationRate)],
                ...(rs.invites ? ([["invites: approved, activated", `${rs.invites.approved}, ${rs.invites.activated}`]] as [string, ReactNode][]) : []),
                ["reviews assigned", num(rs.assigned)],
                ["not submitted", num(rs.notSubmitted)],
                ["submitted late", num(rs.submittedLate)],
                ["dropout rate", percent(rs.dropoutRate)],
              ]}
            />
          )}
          <p className="muted">{rs.reason}</p>
        </Section>

        <Section title="Early-reject yield" testId="report-early-reject">
          <Kv
            rows={[
              ["candidates", er.candidates],
              ["bumped", er.bumped],
              ["not bumped", er.notBumped],
              ["rejected in the end", er.rejected],
              ["yield", percent(er.yield)],
            ]}
          />
          <p className="muted">{er.reason}</p>
        </Section>

        <Section title="Quick and desk reject" testId="report-quick-reject">
          {qr.available ? (
            <Kv
              testId="quick-reject-kv"
              rows={[
                ["in the queue", num(qr.queued)],
                ["AC reject", num(qr.acReject)],
                ["desk-rejected", num(qr.deskRejected)],
                ["kept", num(qr.kept)],
                ["appeals filed", num(qr.appeals?.filed)],
                ["upheld / overturned / pending", `${num(qr.appeals?.upheld)} / ${num(qr.appeals?.overturned)} / ${num(qr.appeals?.pending)}`],
              ]}
            />
          ) : null}
          <p className="muted">{qr.reason}</p>
        </Section>
      </div>

      <div className="ov-grid">
        <Section title="Do-not-invite carry-forward" testId="report-dni">
          <p className="muted">
            {r.doNotInvite.run ? `${r.doNotInvite.run.rows} entries (import run ${r.doNotInvite.run.id}, ${formatDate(r.doNotInvite.run.importedAt, meta.tz)}).` : "No do-not-invite import."}{" "}
            {r.doNotInvite.note}
          </p>
          <a className="btn" href={r.doNotInvite.downloadPath} download data-testid="dni-download">
            Download do-not-invite CSV
          </a>
        </Section>

        <Section title="Pseudonymous export" testId="report-export">
          <p className="muted" data-testid="export-note">
            {r.export.note}
            {r.export.keyId ? ` Key id ${r.export.keyId}.` : ""}
          </p>
          {r.export.keyConfigured ? (
            <p className="export-links">
              <a className="btn" href={r.export.zipPath} download data-testid="export-zip">
                Export (zip)
              </a>{" "}
              {r.export.files.map((f) => (
                <a key={f} className="btn" href={`${r.export.filePath}${f}`} download data-testid="export-file">
                  {f}
                </a>
              ))}
            </p>
          ) : (
            <button type="button" className="btn" disabled data-testid="export-disabled">
              Export (needs PCS_PSEUDONYM_KEY)
            </button>
          )}
        </Section>
      </div>
    </div>
  );
}
