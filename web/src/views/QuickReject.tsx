// Module B, the quick-reject / desk-reject tracker (spec §10.4 B): the queue
// (paper -> signals -> AC decision -> chair action -> appeal state), overdue
// quick-reject reviews, and drafted Mail-tool searches. Read-only: states come
// from the tags and decisions set in HotCRP (PCS_QR_TAGS).

import { createColumnHelper } from "@tanstack/react-table";
import { useMemo } from "react";
import { useQuickReject, type MetaResponse, type QuickRejectItemInfo } from "../api";
import { Chip } from "../components/Chip";
import { DataTable } from "../components/DataTable";
import { formatTime, hotcrp, plural } from "../format";
import { MailDrafts, ModuleWindow, Notes } from "./ModuleParts";

const col = createColumnHelper<QuickRejectItemInfo>();

const STAGE_LABEL = { "ac-decision": "awaiting AC", "chair-action": "awaiting chair", appeal: "appeal open", done: "done" } as const;
const SIGNAL_LABEL = { refcheck: "refcheck", "ac-flag": "AC flag", "qr-verdict": "reject verdict" } as const;

export function QuickReject({ meta }: { meta: MetaResponse }) {
  const q = useQuickReject();
  const d = q.data;
  const columns = useMemo(
    () => [
      col.display({
        id: "pid",
        header: "#",
        size: 64,
        meta: { kind: "numeric", label: "Paper", value: (r) => r.pid },
        cell: (c) => (
          <a className="pid" href={hotcrp.paper(meta.hotcrpUrl, c.row.original.pid)} target="_blank" rel="noreferrer">
            #{c.row.original.pid}
          </a>
        ),
      }),
      col.display({
        id: "signals",
        header: "Signals",
        size: 230,
        meta: { kind: "categorical", value: (r) => r.signals.map((s) => s.kind), format: (v) => SIGNAL_LABEL[v as keyof typeof SIGNAL_LABEL] ?? v },
        cell: (c) => (
          <span className="chips">
            {c.row.original.signals.map((s) => (
              <Chip key={s.kind} tone="warn" title={s.reason}>
                {SIGNAL_LABEL[s.kind]}
              </Chip>
            ))}
            {c.row.original.signals.length === 0 ? <span className="muted">tags only</span> : null}
          </span>
        ),
      }),
      col.display({ id: "ac", header: "AC decision", size: 120, meta: { kind: "categorical", value: (r) => r.acDecision }, cell: (c) => c.row.original.acDecision }),
      col.display({ id: "chair", header: "Chair action", size: 130, meta: { kind: "categorical", value: (r) => r.chairAction }, cell: (c) => c.row.original.chairAction }),
      col.display({
        id: "appeal",
        header: "Appeal",
        size: 110,
        meta: { kind: "categorical", value: (r) => r.appealState },
        cell: (c) => <span data-testid="qr-appeal">{c.row.original.appealState}</span>,
      }),
      col.display({ id: "decision", header: "Decision", size: 110, meta: { kind: "categorical", value: (r) => r.decision }, cell: (c) => c.row.original.decision ?? "—" }),
      col.display({
        id: "stage",
        header: "Stage",
        size: 200,
        meta: { grow: true, kind: "categorical", value: (r) => r.stage, format: (v) => STAGE_LABEL[v as keyof typeof STAGE_LABEL] ?? v },
        cell: (c) => (
          <span className="chips">
            <Chip tone={c.row.original.stage === "done" ? "neutral" : "info"} testId="qr-stage">
              {STAGE_LABEL[c.row.original.stage]}
            </Chip>
            {c.row.original.warnings.map((w) => (
              <Chip key={w.code} tone="alert" title={w.reason}>
                {w.code}
              </Chip>
            ))}
          </span>
        ),
      }),
    ],
    [meta.hotcrpUrl],
  );

  if (q.error) return <p className="error page">Could not load the quick-reject tracker: {q.error.message}</p>;
  if (!d) return <p className="muted page">Loading…</p>;
  const c = d.counts;

  return (
    <div className="page page-scroll" data-testid="quickreject">
      <div className="page-head">
        <h1>Quick-reject tracker</h1>
        <ModuleWindow module={d.module} tz={d.tz} />
      </div>
      <p className="muted" data-testid="qr-counts">
        {plural(c.items, "paper")} in the queue: {c.byStage["ac-decision"]} awaiting AC, {c.byStage["chair-action"]} awaiting chair, {c.byStage.appeal} appeal
        open, {c.byStage.done} done · appeals {c.byAppeal.requested} open, {c.byAppeal.upheld} upheld, {c.byAppeal.overturned} overturned · quick-reject reviews{" "}
        {c.qrReviewsSubmitted}/{c.qrReviews} submitted
        {d.due !== null ? `, due ${formatTime(d.due, d.tz)}` : ""}
      </p>
      <Notes notes={d.notes} />

      <section className="ov-section">
        <h2>Queue</h2>
        <DataTable
          testId="qr-items"
          stateKey="qr"
          noun="papers"
          data={d.items}
          columns={columns}
          rowId={(r) => String(r.pid)}
          rowAttrs={(r) => ({ "data-pid": r.pid, "data-stage": r.stage })}
          empty={<p className="muted">The queue is empty.</p>}
        />
      </section>

      <section className="ov-section">
        <h2>Overdue quick-reject reviews</h2>
        {d.overdueReviews.length === 0 ? <p className="muted">None.</p> : null}
        <ul className="findings" data-testid="qr-overdue">
          {d.overdueReviews.map((o) => (
            <li key={o.rid}>{o.reason}</li>
          ))}
        </ul>
      </section>

      <section className="ov-section">
        <h2>Mail-tool searches</h2>
        <MailDrafts drafts={d.mailDrafts} />
      </section>
    </div>
  );
}
