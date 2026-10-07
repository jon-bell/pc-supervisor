// The overview (spec §5c, Views): paper counts by stage, the score-spread
// histogram, flagged papers per AC, and the burndown of papers without
// consensus against the phase dates. All charts are inline SVG (Charts.tsx).

import { useOverview, type MetaResponse } from "../api";
import { Histogram, LoadBar, TimeLines } from "../components/Charts";
import { formatDate, PHASE_LABELS, plural } from "../format";
import { Link } from "../router";
import { triageForAc } from "./Acs";

function Stat({ label, value, testId, hint }: { label: string; value: number; testId: string; hint?: string }) {
  return (
    <div className="stat" data-testid={testId} title={hint}>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

export function Overview({ meta }: { meta: MetaResponse }) {
  const q = useOverview();
  const d = q.data;
  if (q.error) return <p className="error page">Could not load the overview: {q.error.message}</p>;
  if (!d) return <p className="muted page">Loading…</p>;
  const c = d.counts;
  const maxLoad = Math.max(0, ...d.flaggedPerAc.map((a) => a.load));
  const ts = d.burndown.map((p) => p.t);

  return (
    <div className="page page-scroll" data-testid="overview">
      <div className="page-head">
        <h1>Overview</h1>
        <p className="muted">
          Phase: <strong data-testid="overview-phase">{PHASE_LABELS[d.phase] ?? d.phase}</strong>
        </p>
      </div>

      <section className="ov-section">
        <h2>Papers by stage</h2>
        <div className="stats" data-testid="counts">
          <Stat label="papers" value={c.papers} testId="count-papers" />
          <Stat label="awaiting reviews" value={c.reviewing} testId="count-reviewing" hint={`undecided, fewer than ${d.reviewsRequired} submitted reviews`} />
          <Stat label="in discussion" value={c.discussing} testId="count-discussing" hint="undecided, with enough reviews" />
          <Stat label="decided" value={c.decided} testId="count-decided" />
          <Stat label="no consensus" value={c.noConsensus} testId="count-no-consensus" hint="undecided and split" />
          <Stat label="flagged" value={c.flagged} testId="count-flagged" hint="at least one rule fired" />
        </div>
        <ol className="phase-list" data-testid="phase-dates">
          {d.phases.map((p) => (
            <li key={p.key} className={p.at <= d.now ? "past" : undefined}>
              {p.label} <span className="muted">{formatDate(p.at, meta.tz)}</span>
            </li>
          ))}
        </ol>
      </section>

      <div className="ov-grid">
        <section className="ov-section">
          <h2>Score spread</h2>
          <p className="muted">
            Papers by merit range (highest minus lowest). A range of {d.splitRange} or more is split
            {d.spreadUnknown ? `; ${plural(d.spreadUnknown, "paper")} with fewer than 2 merits not shown` : ""}.
          </p>
          <Histogram
            testId="spread-histogram"
            ariaLabel="Papers by merit range"
            bins={d.spread.map((b) => ({
              label: String(b.range),
              value: b.papers,
              highlight: b.split,
              title: `range ${b.range}: ${plural(b.papers, "paper")}${b.split ? " (split)" : ""}`,
            }))}
          />
          <p className="legend muted">
            <span className="swatch swatch-bar" /> not split <span className="swatch swatch-hl" /> split (range ≥ {d.splitRange})
          </p>
        </section>

        <section className="ov-section">
          <h2>Flagged papers per AC</h2>
          <p className="muted">Alphabetical. The bar is the AC's load; the dark part is flagged papers.</p>
          <ul className="per-ac" data-testid="flagged-per-ac">
            {d.flaggedPerAc.map((a) => (
              <li key={a.person.email} data-testid="ov-ac" data-email={a.person.email}>
                <Link to={triageForAc(a.person.email)} className="ellipsis">
                  {a.person.name}
                </Link>
                <LoadBar load={a.load} flagged={a.flagged} max={maxLoad} />
                <span className="num" data-testid="ov-ac-load">
                  {plural(a.load, "paper")} · {a.flagged} flagged
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <section className="ov-section">
        <h2>Papers without consensus</h2>
        <p className="muted">Daily from the review deadline: undecided papers whose merits are split, and all undecided papers, with the phase dates.</p>
        <TimeLines
          testId="burndown"
          ariaLabel="Papers without consensus over time"
          ts={ts}
          tz={meta.tz}
          series={[
            { key: "noConsensus", label: "no consensus", className: "line-main", values: d.burndown.map((p) => p.noConsensus) },
            { key: "undecided", label: "undecided", className: "line-ref", values: d.burndown.map((p) => p.undecided) },
          ]}
          markers={[
            ...d.phases.map((p) => ({ at: p.at, label: p.label })),
            { at: d.now, label: "Now", className: "marker marker-now" },
          ]}
        />
        <p className="legend muted">
          <span className="swatch swatch-main" /> no consensus <span className="swatch swatch-ref" /> undecided
        </p>
      </section>
    </div>
  );
}
