// Module C, the assignment validator (spec §10.4 C): findings grouped by
// check, with their reasons, for the current HotCRP assignment or the latest
// TPMS proposal, plus the fix-up CSV (dry-run it in HotCRP before applying).
// Read-only; nothing here changes HotCRP.

import { useState } from "react";
import { useAssignment, type MetaResponse } from "../api";
import { Chip } from "../components/Chip";
import { CsvBlock } from "../components/CsvBlock";
import { hotcrp, plural } from "../format";
import { ModuleWindow, Notes } from "./ModuleParts";

const CHECK_LABEL: Record<string, string> = {
  input: "Input rows",
  composition: "Composition",
  load: "Load bands",
  conflict: "Conflict sanity",
  reserve: "Reserve candidates",
  cycle: "Reciprocal cycles (for human review)",
};

export function Assignment({ meta }: { meta: MetaResponse }) {
  const [source, setSource] = useState<"hotcrp" | "tpms">("hotcrp");
  const q = useAssignment(source);
  const d = q.data;

  const picker = (
    <p className="muted">
      Validate:{" "}
      <button type="button" className={`btn${source === "hotcrp" ? " btn-primary" : ""}`} onClick={() => setSource("hotcrp")} data-testid="assignment-source-hotcrp">
        current HotCRP assignment
      </button>{" "}
      <button type="button" className={`btn${source === "tpms" ? " btn-primary" : ""}`} onClick={() => setSource("tpms")} data-testid="assignment-source-tpms">
        latest TPMS proposal
      </button>
    </p>
  );

  if (q.error) {
    return (
      <div className="page page-scroll" data-testid="assignment">
        <div className="page-head">
          <h1>Assignment validator</h1>
        </div>
        {picker}
        <p className="error">Could not validate: {q.error.message}</p>
      </div>
    );
  }
  if (!d) return <p className="muted page">Loading…</p>;
  const r = d.report;
  const checks = [...new Set(r.findings.map((f) => f.check))];
  const removes = r.fixup.lines.filter((l) => l.slot === "remove").length;

  return (
    <div className="page page-scroll" data-testid="assignment">
      <div className="page-head">
        <h1>Assignment validator</h1>
        <ModuleWindow module={d.module} tz={d.tz} />
      </div>
      {picker}
      <p className="muted" data-testid="assignment-counts">
        {r.source === "tpms" ? `TPMS proposal (import #${r.imports.tpmsRunId})` : "Current HotCRP assignment (last sync)"}: {plural(r.counts.papers, "paper")},{" "}
        {plural(r.counts.rows, "assignment row")}, {plural(r.counts.findings, "finding")} ({plural(r.counts.cycles, "reciprocal cycle")}) · policy {r.policy.minSenior} senior + third slot{" "}
        {r.policy.thirdSlot}
      </p>
      <Notes notes={r.notes} />
      {r.findings.length === 0 ? <p className="muted">No findings.</p> : null}
      {checks.map((c) => (
        <section className="ov-section" key={c}>
          <h2>{CHECK_LABEL[c] ?? c}</h2>
          <ul className="findings" data-testid={`assignment-findings-${c}`}>
            {r.findings
              .filter((f) => f.check === c)
              .map((f, i) => (
                <li key={`${f.code}:${f.pid ?? ""}:${f.emails.join()}:${i}`} data-testid="assignment-finding" data-code={f.code}>
                  <Chip tone={f.check === "cycle" ? "info" : "warn"}>{f.code}</Chip>{" "}
                  {f.pid !== undefined ? (
                    <a className="pid" href={hotcrp.paper(meta.hotcrpUrl, f.pid)} target="_blank" rel="noreferrer">
                      #{f.pid}
                    </a>
                  ) : null}{" "}
                  {f.reason}
                  {f.dropped ? <span className="muted"> (left out of the fix-up)</span> : null}
                </li>
              ))}
          </ul>
        </section>
      ))}
      <section className="ov-section">
        <h2>Fix-up CSV</h2>
        <p className="muted">
          {plural(r.fixup.lines.length - removes, "assignment line")}, {plural(removes, "clearreview line")}. Upload it in HotCRP (Assignments → Upload) and check the preview before
          saving; nothing is applied from here.
        </p>
        {r.fixup.gaps.length > 0 ? (
          <ul className="findings">
            {r.fixup.gaps.map((g) => (
              <li key={g.pid}>
                #{g.pid} still needs {[g.seniorsMissing > 0 ? `${g.seniorsMissing} senior` : "", g.thirdMissing > 0 ? "the third slot" : ""].filter(Boolean).join(" and ")}
              </li>
            ))}
          </ul>
        ) : null}
        <CsvBlock csv={r.fixup.csv} testId="assignment-csv" />
      </section>
    </div>
  );
}
