// Module A, reserve-reviewer compliance (spec §10.4 A): counts, the
// non-compliance list and warnings with their reasons, drafted Mail-tool
// searches, and every paper's state in a virtualized table. Designees are
// listed by email, alphabetically (not ranked). DBLP results, if enabled, are
// shown as hints for a human, never verdicts.

import { createColumnHelper } from "@tanstack/react-table";
import { useMemo } from "react";
import { useReserve, type MetaResponse, type ReserveResponse } from "../api";
import { Chip } from "../components/Chip";
import { DataTable } from "../components/DataTable";
import { hotcrp, plural } from "../format";
import { MailDrafts, ModuleWindow, Notes } from "./ModuleParts";

type PaperRow = ReserveResponse["papers"][number];
const col = createColumnHelper<PaperRow>();

const STATE_TONE = { designee: "neutral", exempt: "info", noncompliant: "alert", unchecked: "neutral" } as const;
const STATE_LABEL = { designee: "designee named", exempt: "exemption claimed", noncompliant: "non-compliant", unchecked: "not checked" } as const;

export function Reserve({ meta }: { meta: MetaResponse }) {
  const q = useReserve();
  const d = q.data;
  const columns = useMemo(
    () => [
      col.display({
        id: "pid",
        header: "#",
        size: 64,
        cell: (c) => (
          <a className="pid" href={hotcrp.paper(meta.hotcrpUrl, c.row.original.pid)} target="_blank" rel="noreferrer">
            #{c.row.original.pid}
          </a>
        ),
      }),
      col.display({
        id: "state",
        header: "State",
        size: 150,
        cell: (c) => <Chip tone={STATE_TONE[c.row.original.state]} testId="reserve-state">{STATE_LABEL[c.row.original.state]}</Chip>,
      }),
      col.display({
        id: "who",
        header: "Designee or exemption",
        size: 260,
        cell: (c) => {
          const r = c.row.original;
          return (
            <span className="ellipsis" title={r.identifiedBy === "name" ? "identified by name (matched to an author)" : undefined}>
              {r.designee ?? (r.exemption ? `exemption: ${r.exemption}` : "—")}
              {r.identifiedBy === "name" ? " (by name)" : ""}
            </span>
          );
        },
      }),
      col.display({
        id: "codes",
        header: "Findings",
        size: 220,
        meta: { grow: true },
        cell: (c) => (
          <span className="chips">
            {c.row.original.codes.map((code) => (
              <Chip key={code} tone="warn">
                {code}
              </Chip>
            ))}
            {c.row.original.hints.map((h) => (
              <Chip key={h.name} tone="info" title={h.text}>
                hint: {h.name}
              </Chip>
            ))}
          </span>
        ),
      }),
    ],
    [meta.hotcrpUrl],
  );

  if (q.error) return <p className="error page">Could not load reserve compliance: {q.error.message}</p>;
  if (!d) return <p className="muted page">Loading…</p>;
  const c = d.counts;
  const non = d.findings.filter((f) => f.severity === "noncompliant");
  const warn = d.findings.filter((f) => f.severity === "warning");
  const hinted = d.designees.filter((x) => x.hint);

  return (
    <div className="page page-scroll" data-testid="reserve">
      <div className="page-head">
        <h1>Reserve compliance</h1>
        <ModuleWindow module={d.module} tz={d.tz} />
      </div>
      <p className="muted" data-testid="reserve-counts">
        {plural(c.papers, "paper")}: {c.designee} with a designee, {c.exempt} exempt, {c.noncompliant} non-compliant · {plural(c.designees, "designee")} ·{" "}
        {plural(c.warnings, "warning")} · max cover {d.policy.maxCover} papers per designee (PCS_RESERVE_MAX_COVER)
      </p>
      <Notes notes={d.notes} />

      <section className="ov-section">
        <h2>Non-compliant papers</h2>
        {non.length === 0 ? <p className="muted">None.</p> : null}
        <ul className="findings" data-testid="reserve-noncompliant">
          {non.map((f) => (
            <li key={`${f.code}:${f.pids.join()}`} data-testid="reserve-finding" data-code={f.code}>
              <Chip tone="alert">{f.code}</Chip> {f.reason}
            </li>
          ))}
        </ul>
        <h2>Warnings</h2>
        {warn.length === 0 ? <p className="muted">None.</p> : null}
        <ul className="findings" data-testid="reserve-warnings">
          {warn.map((f) => (
            <li key={`${f.code}:${f.emails.join()}`} data-testid="reserve-finding" data-code={f.code}>
              <Chip tone="warn">{f.code}</Chip> {f.reason}
            </li>
          ))}
        </ul>
      </section>

      <section className="ov-section">
        <h2>Mail-tool searches</h2>
        <p className="muted">Paste a search into HotCRP's Mail tool and pick the recipients shown. Nothing is sent from here.</p>
        <MailDrafts drafts={d.mailDrafts} />
      </section>

      {d.dblp.enabled ? (
        <section className="ov-section" data-testid="reserve-dblp">
          <h2>DBLP hints</h2>
          <p className="muted">
            Hints for a human, never verdicts: a name can match a different person. Looked up {d.dblp.looked} names ({d.dblp.pending} pending,{" "}
            {d.dblp.failed} failed) at {d.dblp.source}; only public author names were sent.
          </p>
          <ul className="findings">
            {hinted.map((x) => (
              <li key={x.email}>
                {x.email}: {x.hint!.text}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="ov-section">
        <h2>All papers</h2>
        <DataTable
          testId="reserve-papers"
          data={d.papers}
          columns={columns}
          rowId={(r) => String(r.pid)}
          rowAttrs={(r) => ({ "data-pid": r.pid, "data-state": r.state })}
          empty={<p className="muted">No papers synced yet.</p>}
        />
      </section>
    </div>
  );
}
