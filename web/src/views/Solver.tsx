// The assignment solver (spec §10.5, PLAN M10b): run it on demand (it reads
// HotCRP's conflicts and preferences, read-only), then show the solve report:
// objective, unmet requirements per paper, the load histogram by tier (counts
// of reviewers per load, not a ranking of people), the repairs made, what is
// left unresolved, affinity coverage, M10's validator cross-check, and the
// HotCRP bulk-assign CSV. Nothing is applied from here.

import type { ReactNode } from "react";
import { useRunSolve, useSolve, type MetaResponse } from "../api";
import { Chip } from "../components/Chip";
import { CsvBlock } from "../components/CsvBlock";
import { MiniTable, type MiniColumn } from "../components/MiniTable";
import type { SolveReport } from "@pcs/server/server/assignment-types";
import { formatTime, plural } from "../format";
import { useTiersConfigured } from "../tiers";
import { ModuleWindow, Notes } from "./ModuleParts";

const LIST_MAX = 100;

type LoadRow = SolveReport["load"][number];

/** The load histogram by tier: counts of reviewers per load, sortable (no people are listed). */
function loadColumns(tiers: boolean): MiniColumn<LoadRow>[] {
  return [
    ...(tiers ? [{ id: "tier", header: "Tier", kind: "text" as const, value: (t: LoadRow) => t.tier, cell: (t: LoadRow) => t.tier }] : []),
    { id: "band", header: "Band", kind: "numeric", value: (t) => t.band?.min ?? null, cell: (t) => (t.band ? `${t.band.min}–${t.band.max}` : "none") },
    { id: "reviewers", header: "Reviewers", kind: "numeric", value: (t) => t.reviewers, cell: (t) => t.reviewers },
    { id: "histogram", header: "Reviewers per load", cell: (t) => t.histogram.map((h) => `${h.load}: ${h.reviewers}`).join(" · ") },
    { id: "under", header: "Under", kind: "numeric", value: (t) => t.under, cell: (t) => t.under },
    { id: "over", header: "Over", kind: "numeric", value: (t) => t.over, cell: (t) => t.over },
  ];
}

function Capped<T>({ items, render, testId, empty }: { items: readonly T[]; render: (x: T, i: number) => ReactNode; testId: string; empty: string }) {
  if (items.length === 0) return <p className="muted">{empty}</p>;
  return (
    <ul className="findings" data-testid={testId}>
      {items.slice(0, LIST_MAX).map(render)}
      {items.length > LIST_MAX ? <li className="muted">… and {items.length - LIST_MAX} more (pcs solve-assignments --report for all)</li> : null}
    </ul>
  );
}

export function Solver({ meta: _meta }: { meta: MetaResponse }) {
  const tiers = useTiersConfigured();
  const q = useSolve();
  const run = useRunSolve();
  const d = run.data ?? q.data;

  if (q.error) return <p className="error page">Could not load the solver: {q.error.message}</p>;
  if (!d) return <p className="muted page">Loading…</p>;
  const r = d.report;
  const busy = run.isPending || d.running;

  return (
    <div className="page page-scroll" data-testid="solver">
      <div className="page-head">
        <h1>Assignment solver</h1>
        <ModuleWindow module={d.module} tz={d.tz} />
      </div>
      <p className="muted">
        Min-cost flow over the tiered network (seniors, then one junior or reserve-active third slot), then repair passes for reciprocal cycles and same-institution
        panels. It reads the last sync, the imports, and HotCRP&apos;s conflicts and preferences; it never changes HotCRP.
      </p>
      <p>
        <button type="button" className="btn btn-primary" disabled={busy || !d.available} onClick={() => run.mutate({ hard: false })} data-testid="solver-run">
          {busy ? "Solving…" : "Run solver"}
        </button>{" "}
        <button type="button" className="btn" disabled={busy || !d.available} onClick={() => run.mutate({ hard: true })} data-testid="solver-run-hard">
          Run with hard slots
        </button>
        {!d.available ? <span className="muted"> The solver needs HotCRP access, which this server doesn&apos;t have.</span> : null}
        {run.error ? <span className="error"> {run.error.message}</span> : null}
      </p>
      {r === null ? (
        <p className="muted" data-testid="solver-empty">
          No solve yet.
        </p>
      ) : (
        <>
          <p className="muted" data-testid="solver-summary" data-feasible={r.feasible ? "1" : "0"}>
            {r.mode === "hard" ? "Hard" : "Soft"} solve{d.computedAt !== null ? ` at ${formatTime(d.computedAt, d.tz)}` : ""}
            {r.feasible ? "" : " — infeasible"} · {plural(r.counts.papers, "paper")}, {plural(r.counts.reviewers, "reviewer")} · {plural(r.counts.assignments, "assignment")} (
            {r.counts.kept} kept, {r.counts.added} new, {r.counts.cleared} cleared) · objective {r.objective} (load cost minus affinity {r.affinityObjective}) ·{" "}
            {plural(r.counts.solves, "solve")} in {Math.round(r.timing.totalMs)} ms
          </p>
          <p className="muted">
            Affinity: tpms-scores {r.sources.tpmsRunId !== null ? `#${r.sources.tpmsRunId}` : "(none)"}, affinity-local {r.sources.localRunId !== null ? `#${r.sources.localRunId}` : "(none)"}, HotCRP
            preferences {r.sources.hotcrpPrefs === null ? "(not fetched)" : plural(r.sources.hotcrpPrefs, "row")} · {plural(r.sources.conflicts, "HotCRP conflict")}
          </p>
          <Notes notes={r.notes} />

          <section className="ov-section">
            <h2>Unmet requirements</h2>
            <Capped items={r.unmet} testId="solver-unmet" empty="None: every paper meets its composition." render={(u) => <li key={`${u.pid}:${u.slot}`} data-pid={u.pid}>{u.reason}</li>} />
          </section>

          <section className="ov-section">
            <h2>{tiers ? "Load by tier" : "Load"}</h2>
            <MiniTable testId="solver-load" stateKey="load" rows={r.load} columns={loadColumns(tiers)} rowKey={(t) => t.tier} rowAttrs={(t) => ({ "data-tier": t.tier })} />
          </section>

          <section className="ov-section">
            <h2>Repairs</h2>
            <Capped
              items={r.repairs}
              testId="solver-repairs"
              empty="None needed."
              render={(x, i) => (
                <li key={i} data-kind={x.kind}>
                  <Chip tone="info">{x.kind === "cycle" ? "cycle" : "institution"}</Chip> round {x.round}: {x.reason}
                </li>
              )}
            />
            {r.unresolved.length > 0 ? (
              <>
                <h2>Unresolved</h2>
                <Capped items={r.unresolved} testId="solver-unresolved" empty="" render={(u, i) => <li key={i}>{u.reason}</li>} />
              </>
            ) : null}
            {r.pinIssues.length > 0 ? (
              <>
                <h2>Pinned assignments</h2>
                <Capped items={r.pinIssues} testId="solver-pins" empty="" render={(p, i) => <li key={i}>{p.reason}</li>} />
              </>
            ) : null}
          </section>

          <section className="ov-section">
            <h2>Affinity coverage</h2>
            <p className="muted">
              {plural(r.coverage.weak.length, "paper")} whose best eligible candidate scores below {r.coverage.threshold} (PCS_SOLVER_WEAK_AFFINITY) ·{" "}
              {plural(r.coverage.unscoredAssignments, "assignment")} without a score
            </p>
            <Capped items={r.coverage.weak} testId="solver-coverage" empty="" render={(w) => <li key={w.pid}>{w.reason}</li>} />
          </section>

          <section className="ov-section">
            <h2>Validator cross-check</h2>
            <p className="muted" data-testid="solver-crosscheck">
              M10&apos;s validator on the solved assignment: {plural(r.crossCheck.findings.length, "finding")}, {r.crossCheck.unexplained} unexplained.
            </p>
            <Capped
              items={r.crossCheck.findings}
              testId="solver-crosscheck-findings"
              empty=""
              render={(f, i) => (
                <li key={i}>
                  <Chip tone={f.explainedBy === null ? "alert" : "neutral"}>{f.code}</Chip> {f.reason}
                  <span className="muted"> — {f.explainedBy ?? "not explained by the solve report"}</span>
                </li>
              )}
            />
          </section>

          <section className="ov-section">
            <h2>HotCRP bulk-assign CSV</h2>
            <p className="muted">
              paper,action,email,round: seniors as primary, the third slot as secondary, kept assignments with their current type, and clearreview for unstarted reviews the
              solve drops. Upload it in HotCRP (Assignments → Upload) and check the preview before saving.
            </p>
            <CsvBlock csv={r.csv} testId="solver-csv" />
          </section>
        </>
      )}
    </div>
  );
}
