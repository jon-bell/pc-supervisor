// The overview (spec §5c, Views): an at-a-glance status page for the chair.
// Top: the phase, the next deadline and the phase dates. Then "needs a look
// today": the highest-severity papers, the rules firing most, and the ACs
// with an outlier mark (outliers.tsx) next to their flagged load. Then the
// pipeline of papers by stage, the score-spread histogram and the burndown of
// papers without consensus against the phase dates. Charts are inline SVG
// (Charts.tsx). Nothing here ranks people: ACs stay alphabetical.

import { useMemo } from "react";
import { useAcs, useOverview, useTriage, type MetaResponse, type OverviewResponse } from "../api";
import { Histogram, LoadBar, TimeLines } from "../components/Charts";
import { LevelBars, levelOf, ReasonChips } from "../components/Chip";
import { SeverityCell } from "../components/Severity";
import { daysUntil, formatDate, nextPhaseDate, PHASE_LABELS, plural, ruleLabel } from "../format";
import { cohorts, type Mark } from "../outliers";
import { Link } from "../router";
import { AC_METRICS, triageForAc } from "./Acs";

const WORST = 6;

function Stat({ label, value, testId, hint, tone }: { label: string; value: number; testId: string; hint?: string; tone?: "attention" }) {
  return (
    <div className={`stat${tone ? ` stat-${tone}` : ""}`} data-testid={testId} title={hint}>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

/** Papers by stage as one bar: awaiting reviews, in discussion, decided. */
function Pipeline({ c, reviewsRequired }: { c: OverviewResponse["counts"]; reviewsRequired: number }) {
  const total = Math.max(1, c.reviewing + c.discussing + c.decided);
  const seg = (n: number) => `${(100 * n) / total}%`;
  return (
    <div className="pipeline">
      <div className="pipeline-bar" role="img" aria-label={`${c.reviewing} awaiting reviews, ${c.discussing} in discussion, ${c.decided} decided`}>
        {c.reviewing ? <span className="pl-seg pl-reviewing" style={{ width: seg(c.reviewing) }} title={`${c.reviewing} awaiting reviews`} /> : null}
        {c.discussing ? <span className="pl-seg pl-discussing" style={{ width: seg(c.discussing) }} title={`${c.discussing} in discussion`} /> : null}
        {c.decided ? <span className="pl-seg pl-decided" style={{ width: seg(c.decided) }} title={`${c.decided} decided`} /> : null}
      </div>
      <div className="stats" data-testid="counts">
        <Stat label="papers" value={c.papers} testId="count-papers" />
        <Stat label="awaiting reviews" value={c.reviewing} testId="count-reviewing" hint={`undecided, fewer than ${reviewsRequired} submitted reviews`} />
        <Stat label="in discussion" value={c.discussing} testId="count-discussing" hint="undecided, with enough reviews" />
        <Stat label="decided" value={c.decided} testId="count-decided" />
        <Stat label="no consensus" value={c.noConsensus} testId="count-no-consensus" hint="undecided and split" tone="attention" />
        <Stat label="flagged" value={c.flagged} testId="count-flagged" hint="at least one rule fired" tone="attention" />
      </div>
    </div>
  );
}

/** The phase dates on one ruler, with now. */
function PhaseRuler({ phases, now, tz }: { phases: OverviewResponse["phases"]; now: number; tz: string }) {
  if (phases.length === 0) return null;
  const t0 = Math.min(phases[0]!.at, now);
  const t1 = Math.max(phases[phases.length - 1]!.at, now);
  const X = (t: number) => (t1 > t0 ? (100 * (t - t0)) / (t1 - t0) : 0);
  return (
    <div className="ruler">
      <div className="ruler-track">
        <span className="ruler-done" style={{ width: `${X(now)}%` }} />
        {phases.map((p) => (
          <span key={p.key} className={`ruler-tick${p.at <= now ? " past" : ""}`} style={{ left: `${X(p.at)}%` }} />
        ))}
        <span className="ruler-now" style={{ left: `${X(now)}%` }} title="now" />
      </div>
      <ol className="phase-list" data-testid="phase-dates">
        {phases.map((p) => (
          <li key={p.key} className={p.at <= now ? "past" : undefined}>
            {p.label} <span className="muted">{formatDate(p.at, tz)}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function Overview({ meta }: { meta: MetaResponse }) {
  const q = useOverview();
  const triage = useTriage({});
  const acs = useAcs();
  const d = q.data;
  const ac = useMemo(() => cohorts(acs.data?.acs ?? [], AC_METRICS), [acs.data]);
  const acMarks = useMemo(() => {
    const out = new Map<string, Mark[]>();
    for (const r of acs.data?.acs ?? []) {
      const marks = Object.values(ac).flatMap((c) => {
        const m = c.mark(r);
        return m ? [m] : [];
      });
      out.set(r.person.email, marks);
    }
    return out;
  }, [ac, acs.data]);

  if (q.error) return <p className="error page">Could not load the overview: {q.error.message}</p>;
  if (!d) return <p className="muted page">Loading…</p>;
  const c = d.counts;
  const maxLoad = Math.max(0, ...d.flaggedPerAc.map((a) => a.load));
  const ts = d.burndown.map((p) => p.t);
  const papers = triage.data?.papers ?? [];
  const worst = papers.filter((p) => p.severity > 0).slice(0, WORST);
  const maxSev = papers[0]?.severity ?? 0;
  const weights = new Map(meta.rules.map((r) => [r.name, r.weight]));
  const rules = [...(triage.data?.facets.rules ?? [])].filter((r) => r.papers > 0).sort((a, b) => b.papers - a.papers || a.rule.localeCompare(b.rule));
  const maxRule = Math.max(1, ...rules.map((r) => r.papers));
  const next = nextPhaseDate(meta);

  return (
    <div className="page page-scroll" data-testid="overview">
      <div className="page-head ov-head">
        <h1>Overview</h1>
        <p className="ov-phase">
          Phase: <strong data-testid="overview-phase">{PHASE_LABELS[d.phase] ?? d.phase}</strong>
          {next ? (
            <>
              {" "}
              <span className="muted">
                · {next.label} {daysUntil(next.at, meta.now)} ({formatDate(next.at, meta.tz)})
              </span>
            </>
          ) : null}
        </p>
        <PhaseRuler phases={d.phases} now={d.now} tz={meta.tz} />
      </div>

      <section className="ov-section">
        <h2>Needs a look</h2>
        <div className="ov-today">
          <div className="panel" data-testid="ov-worst">
            <h3>
              Highest severity <span className="muted">({plural(c.flagged, "flagged paper")})</span>
            </h3>
            {worst.length === 0 ? (
              <p className="muted">No rule fires on any paper.</p>
            ) : (
              <ul className="worst">
                {worst.map((p) => (
                  <li key={p.pid}>
                    <SeverityCell sev={p.severity} max={maxSev} testId="ov-worst-sev" />
                    <Link to={`/papers/${p.pid}`} className="worst-title">
                      <span className="pid">#{p.pid}</span> <span className="ellipsis">{p.title}</span>
                    </Link>
                    <ReasonChips reasons={p.reasons} max={2} />
                  </li>
                ))}
              </ul>
            )}
            {c.flagged > worst.length ? (
              <p className="panel-more">
                <Link to="/">All {plural(c.flagged, "flagged paper")} in triage</Link>
              </p>
            ) : null}
          </div>

          <div className="panel" data-testid="ov-rules">
            <h3>Rules firing</h3>
            {rules.length === 0 ? (
              <p className="muted">None.</p>
            ) : (
              <ul className="rule-bars">
                {rules.map((r) => {
                  const level = levelOf(weights.get(r.rule) ?? 1);
                  return (
                    <li key={r.rule} className={`lvl-${level}`}>
                      <Link to={`/?${new URLSearchParams({ rule: r.rule }).toString()}`} className="rule-name">
                        <LevelBars level={level} /> {ruleLabel(r.rule)}
                      </Link>
                      <span className="rule-bar" aria-hidden="true">
                        <i style={{ width: `${(100 * r.papers) / maxRule}%` }} />
                      </span>
                      <span className="num">{r.papers}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="panel" data-testid="flagged-per-ac">
            <h3>Area chairs</h3>
            <p className="muted panel-note">Alphabetical. Bar: load, dark part flagged. Marks: far from the other ACs (see the ACs page).</p>
            <ul className="per-ac">
              {d.flaggedPerAc.map((a) => {
                const marks = acMarks.get(a.person.email) ?? [];
                return (
                  <li key={a.person.email} data-testid="ov-ac" data-email={a.person.email}>
                    <Link to={triageForAc(a.person.email)} className="ellipsis person-link">
                      {a.person.name}
                    </Link>
                    <LoadBar load={a.load} flagged={a.flagged} max={maxLoad} />
                    <span className="num" data-testid="ov-ac-load">
                      {plural(a.load, "paper")} · {a.flagged} flagged
                    </span>
                    <span className="ov-ac-marks">
                      {marks.map((m) => (
                        <span key={m.text} className={`om om-mark om-${m.side}`} title={m.text}>
                          <svg className="om-icon" width="9" height="9" viewBox="0 0 10 10" role="img" aria-label={m.text}>
                            {m.side === "low" ? <path d="M1 2.5h8L5 8.5z" /> : <path d="M1 7.5h8L5 1.5z" />}
                          </svg>
                          {m.text.split(";")[0]!.replace(/ \(.*\)$/, "")}
                        </span>
                      ))}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      </section>

      <section className="ov-section">
        <h2>Papers by stage</h2>
        <Pipeline c={c} reviewsRequired={d.reviewsRequired} />
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
            markers={[...d.phases.map((p) => ({ at: p.at, label: p.label })), { at: d.now, label: "Now", className: "marker marker-now" }]}
          />
          <p className="legend muted">
            <span className="swatch swatch-main" /> no consensus <span className="swatch swatch-ref" /> undecided
          </p>
        </section>
      </div>
    </div>
  );
}
