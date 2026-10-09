// Process report (spec §10.4 G, PLAN M13): aggregates by tier (depth,
// timeliness, merit distribution, review ratings, score agreement), reserve
// activation and dropout, early-reject yield, quick/desk-reject counts and
// appeals, the do-not-invite carry-forward, and the pseudonymous export.
// Aggregates only: no people are listed, and groups smaller than
// PCS_REPORT_MIN_CELL show "fewer than N" instead of numbers. Downloads come
// from the local server to this browser; nothing is uploaded anywhere.
// The per-tier tables sort by any column (MiniTable) but have no column
// filters: a handful of tier rows needs none. The key/value tables (Kv) are
// summaries, not lists, and stay plain.

import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { AgreementRow, Cell, DepthRow, ProcessReport, RatingRow, TimelinessRow } from "@pcs/server/modules/report/types";
import { getJson, type MetaResponse } from "../api";
import { Histogram } from "../components/Charts";
import { MiniTable, numColumn, type MiniColumn } from "../components/MiniTable";
import { formatDate, formatTime, PHASE_LABELS, percent, tierLabel } from "../format";
import { useTiersConfigured } from "../tiers";

export function useReport() {
  return useQuery({ queryKey: ["report"], queryFn: () => getJson<ProcessReport>("/api/report") });
}

const num = (v: number | null | undefined, digits = 0) => (v === null || v === undefined ? "–" : digits ? v.toFixed(digits) : String(v));

/** The row label when PCS_TIER_TAGS is empty (one "senior" group: everyone). */
const ALL_REVIEWERS = "All reviewers";

/**
 * One row per tier, sortable by any column (MiniTable): the tier, its
 * people, then `columns`. A group under PCS_REPORT_MIN_CELL shows "fewer than
 * N people; withheld" across the rest and sorts last.
 */
function TierTable<T extends Cell & { tier: string }>({ rows, columns, stateKey, rowTestId, minCell }: { rows: readonly T[]; columns: MiniColumn<T>[]; stateKey: string; rowTestId: string; minCell: number }) {
  const tiers = useTiersConfigured();
  const label = (r: T) => (tiers ? tierLabel(r.tier) : ALL_REVIEWERS);
  const all: MiniColumn<T>[] = [
    { id: "tier", header: tiers ? "Tier" : "Reviewers", label: "Tier", rowHeader: true, kind: "text", value: label, cell: label },
    numColumn("people", "Reviewers", (r) => r.people),
    ...columns,
  ];
  return (
    <MiniTable
      rows={rows}
      columns={all}
      stateKey={stateKey}
      rowKey={(r) => r.tier}
      rowAttrs={(r) => ({ "data-testid": rowTestId, "data-tier": r.tier, "data-suppressed": r.suppressed ? "1" : "0" })}
      suppressed={(r) =>
        r.suppressed ? (
          <td colSpan={99} className="muted" data-testid="suppressed" title={`Numbers withheld: fewer than PCS_REPORT_MIN_CELL=${minCell} people`}>
            fewer than {minCell} people; withheld
          </td>
        ) : null
      }
    />
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
  // No PCS_TIER_TAGS: one group, so no tier wording anywhere.
  const tiers = meta.tiersConfigured;
  const byTier = tiers ? " by tier" : "";
  const label = (t: string) => (tiers ? tierLabel(t) : ALL_REVIEWERS);
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

      <Section title={`Review depth${byTier}`} testId="report-depth" intro={`Words in submitted reviewer reviews. The floor is PCS_THRESH_MIN_WORDS=${r.depth.minWords}.`}>
        <TierTable
          rows={r.depth.rows}
          stateKey="depth"
          rowTestId="depth-row"
          minCell={m}
          columns={[
            numColumn<DepthRow>("reviews", "Reviews", (d) => d.reviews),
            numColumn<DepthRow>("median", "Median", (d) => d.median, undefined, "depth-median"),
            numColumn<DepthRow>("p25", "p25–p75", (d) => d.p25, (d) => `${num(d.p25)}–${num(d.p75)}`),
            numColumn<DepthRow>("mean", "Mean", (d) => d.mean, (d) => num(d.mean, 1)),
            numColumn<DepthRow>("underFloor", "Under floor", (d) => d.underFloor),
          ]}
        />
        <div className="ov-grid">
          {r.depth.rows
            .filter((d) => d.bins)
            .map((d) => (
              <figure key={d.tier} className="small-multiple">
                <figcaption>{label(d.tier)}: words per review</figcaption>
                <Histogram
                  testId={`depth-histogram-${d.tier}`}
                  ariaLabel={`${label(d.tier)}: submitted reviews by word count`}
                  bins={d.bins!.map((b) => ({ label: b.label, value: b.count, highlight: b.from < r.depth.minWords, title: `${b.label} words: ${b.count} reviews` }))}
                />
              </figure>
            ))}
        </div>
      </Section>

      <Section title={`Timeliness${byTier}`} testId="report-timeliness" intro={`First submission vs the review deadline (${formatDate(r.timeliness.reviewDue, meta.tz)}). Replacements assigned after the deadline are never late.`}>
        <TierTable
          rows={r.timeliness.rows}
          stateKey="time"
          rowTestId="timeliness-row"
          minCell={m}
          columns={[
            numColumn<TimelinessRow>("assigned", "Assigned", (d) => d.assigned),
            numColumn<TimelinessRow>("onTime", "On time", (d) => d.onTime, (d) => `${num(d.onTime)} (${percent(d.onTimeShare)})`),
            numColumn<TimelinessRow>("late", "Late", (d) => d.late),
            numColumn<TimelinessRow>("notSubmitted", "Not submitted", (d) => d.notSubmitted),
            numColumn<TimelinessRow>("assignedAfterDue", "Assigned after deadline", (d) => d.assignedAfterDue),
            numColumn<TimelinessRow>("medianDaysVsDue", "Median vs deadline", (d) => d.medianDaysVsDue, (d) =>
              d.medianDaysVsDue === null ? "–" : `${d.medianDaysVsDue > 0 ? "+" : ""}${d.medianDaysVsDue.toFixed(1)} d`,
            ),
          ]}
        />
      </Section>

      <Section title={`Merit distribution${byTier}`} testId="report-merits" intro={`Submitted reviewer merits (${r.merits.field}); accept side from ${r.merits.acceptMin}.`}>
        <div className="ov-grid">
          {r.merits.rows.map((d) =>
            d.bins ? (
              <figure key={d.tier} className="small-multiple" data-testid="merit-row" data-tier={d.tier}>
                <figcaption>
                  {label(d.tier)}: {d.reviews} merits, mean {num(d.mean, 2)}
                </figcaption>
                <Histogram
                  testId={`merit-histogram-${d.tier}`}
                  ariaLabel={`${label(d.tier)}: merit distribution`}
                  bins={d.bins.map((b) => ({ label: b.label, value: b.count, highlight: b.from >= r.merits.acceptMin, title: `merit ${b.label}: ${b.count}` }))}
                />
              </figure>
            ) : (
              <p key={d.tier} className="muted" data-testid="merit-row" data-tier={d.tier} data-suppressed="1">
                {label(d.tier)}: fewer than {m} people; withheld
              </p>
            ),
          )}
        </div>
      </Section>

      <Section
        title={`Review-rating flags${byTier}`}
        testId="report-ratings"
        intro="HotCRP review-rating flags received by submitted reviews: flags in all (each rater's flag counts once), and per review."
      >
        {!r.ratings.enabled ? (
          <p className="muted" data-testid="ratings-off">
            Review ratings are off in HotCRP, so there is nothing to show.
          </p>
        ) : (
        <TierTable
          rows={r.ratings.rows}
          stateKey="rate"
          rowTestId="rating-row"
          minCell={m}
          columns={[
            numColumn<RatingRow>("reviews", "Reviews", (d) => d.reviews),
            numColumn<RatingRow>("rated", "Rated", (d) => d.rated),
            ...r.ratings.names.map((n) => ({
              ...numColumn<RatingRow>(`flag-${n.replace(/[^A-Za-z0-9_-]/g, "_")}`, n, (d) => d.counts?.[n] ?? null, (d) => (
                <>
                  {num(d.counts?.[n])}
                  {d.perReview ? <span className="muted"> ({d.perReview[n]}/review)</span> : null}
                </>
              )),
              tdAttrs: (d: RatingRow) => (d.perReview ? { title: `${d.perReview[n]} per review` } : ({} as Record<string, string>)),
            })),
          ]}
        />
        )}
      </Section>

      <Section title={`Score agreement${byTier}`} testId="report-agreement" intro="Mean absolute deviation of a merit from its paper's mean (papers with 2+ merits), and how often merits sit on the final decision's side.">
        <TierTable
          rows={r.agreement.rows}
          stateKey="agree"
          rowTestId="agreement-row"
          minCell={m}
          columns={[
            numColumn<AgreementRow>("reviews", "Merits", (d) => d.reviews),
            numColumn<AgreementRow>("mad", "Mean |dev|", (d) => d.meanAbsDev, (d) => num(d.meanAbsDev, 2), "agreement-mad"),
            numColumn<AgreementRow>("decided", "On decided papers", (d) => d.decided),
            numColumn<AgreementRow>("onDecisionSide", "On the decision's side", (d) => d.onDecisionSide, (d) => `${num(d.onDecisionSide)} (${percent(d.share)})`),
          ]}
        />
      </Section>

      <div className="ov-grid">
        <Section title="Reserve activation and dropout" testId="report-reserve" intro={tiers ? `Tiers: ${rs.tiers.join(", ") || "none"}.` : ""}>
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
