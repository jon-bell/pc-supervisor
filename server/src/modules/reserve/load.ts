// Build the reserve check's input from the local store and the imports (no
// HotCRP calls): live, non-withdrawn papers with their authors (migration 4)
// and the three configured option values, which options exist in HotCRP, the
// current PC, known names, and the latest tpms-registrations import as of `at`.
// Four indexed scans, whatever the number of papers.

import type { ReservePolicy } from "../../config.js";
import { rowsAsOf } from "../../imports/store.js";
import type { Store } from "../../store/store.js";
import { paperAuthors, submissionFields } from "../../store/submissions.js";
import type { InputPaper, ReserveInput } from "./types.js";

export function loadReserveInput(store: Store, policy: ReservePolicy, at: Date): ReserveInput {
  const db = store.db;
  const papers = new Map<number, InputPaper & { authors: { email: string | null; name: string | null }[] }>();
  for (const r of db
    .prepare(
      "select pid, title from paper where deleted_seen_at is null and (status is null or lower(status) not like '%withdrawn%') order by pid",
    )
    .all() as { pid: number; title: string | null }[]) {
    papers.set(r.pid, { pid: r.pid, title: r.title ?? "", authors: [], designee: undefined, exemption: undefined, seniority: undefined });
  }
  for (const a of paperAuthors(db)) papers.get(a.pid)?.authors.push({ email: a.email, name: a.name });

  const names = [policy.designeeField, policy.exemptionField, policy.seniorityField];
  const opts = db
    .prepare("select pid, name, value from paper_option where removed_seen_at is null and name in (?, ?, ?)")
    .all(...names) as { pid: number; name: string; value: string }[];
  for (const o of opts) {
    const p = papers.get(o.pid);
    if (!p) continue;
    const v = JSON.parse(o.value) as unknown;
    if (o.name === policy.designeeField) p.designee = v;
    if (o.name === policy.exemptionField) p.exemption = v;
    if (o.name === policy.seniorityField) p.seniority = v;
  }

  const sf = new Map(submissionFields(db).map((f) => [f.name, f.type]));
  const fieldType = (n: string) => (sf.has(n) ? (sf.get(n) ?? null) : undefined);

  const pc = new Set<string>();
  const known = new Map<string, string>();
  for (const p of store.people({ includeGone: true })) {
    if (p.isPc && p.removedSeenAt === null) pc.add(p.email);
    if (p.name) known.set(p.email, p.name);
  }

  const t = rowsAsOf(db, "tpms-registrations", at);
  return {
    papers: [...papers.values()],
    fields: { designee: fieldType(policy.designeeField), exemption: fieldType(policy.exemptionField), seniority: fieldType(policy.seniorityField) },
    pc,
    names: known,
    tpms: t.run ? { runId: t.run.id, rows: t.rows } : undefined,
  };
}
