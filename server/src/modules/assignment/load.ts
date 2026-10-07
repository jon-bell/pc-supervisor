// Build the validator's input from the local store and the imports (no
// HotCRP calls): live papers with authors (migration 4), people with tiers and
// affiliations, current review assignments with review status, ACs per
// PCS_AC_ROLE, and the latest invites / do-not-invite / tpms-assignments
// imports as of `at` (the app clock).

import type { Config } from "../../config.js";
import { rowsAsOf } from "../../imports/store.js";
import type { Store } from "../../store/store.js";
import { paperAuthors } from "../../store/submissions.js";
import type { CoauthorshipSource } from "./dblp.js";
import type { AssignmentSource, CurrentAssignment, PaperInfo, PersonInfo, ProposedRow, ValidatorInput } from "./types.js";

export class NoTpmsImportError extends Error {
  constructor() {
    super("no tpms-assignments import yet; run: pcs import tpms-assignments <file.csv>");
    this.name = "NoTpmsImportError";
  }
}

export interface LoadOptions {
  source: AssignmentSource;
  /** Imports are read as of this instant (normally clock.now()). */
  at: Date;
  coauthors?: CoauthorshipSource;
}

export function loadValidatorInput(store: Store, cfg: Pick<Config, "acRole">, opts: LoadOptions): ValidatorInput {
  const db = store.db;
  const papers = new Map<number, PaperInfo>();
  for (const { pid } of db.prepare("select pid from paper where deleted_seen_at is null order by pid").all() as { pid: number }[]) {
    papers.set(pid, { pid, authors: [] });
  }
  for (const a of paperAuthors(db)) {
    const p = papers.get(a.pid);
    if (p) (p.authors as { email: string | null; affiliation: string | null }[]).push({ email: a.email, affiliation: a.affiliation });
  }

  const acs = new Set(store.areaChairs(cfg.acRole).map((r) => r.email));
  const people = new Map<string, PersonInfo>();
  for (const p of store.people({ includeGone: true })) {
    people.set(p.email, {
      email: p.email,
      affiliation: p.affiliation,
      isPc: p.isPc && p.removedSeenAt === null,
      tier: p.tier,
      exempt: p.roles.includes("chair") || acs.has(p.email),
    });
  }

  const current = (
    db
      .prepare(
        `select a.pid, a.email, a.role,
           (select r.status from review r where r.pid = a.pid and r.email = a.email and r.deleted_seen_at is null
              and (r.rtype is null or r.rtype != 5) order by r.rid limit 1) as status
         from assignment a
         where a.removed_seen_at is null and a.role in ('primary', 'secondary', 'pc')
         order by a.pid, a.email`,
      )
      .all() as CurrentAssignment[]
  ).filter((c, i, xs) => i === 0 || xs[i - 1]!.pid !== c.pid || xs[i - 1]!.email !== c.email);

  const inv = rowsAsOf(db, "invites", opts.at);
  const dni = rowsAsOf(db, "do-not-invite", opts.at);

  let proposal: ProposedRow[];
  let tpmsRunId: number | undefined;
  if (opts.source === "tpms") {
    const t = rowsAsOf(db, "tpms-assignments", opts.at);
    if (!t.run) throw new NoTpmsImportError();
    tpmsRunId = t.run.id;
    proposal = t.rows.map((r) => ({ pid: r.pid, email: r.email.toLowerCase(), score: r.score }));
  } else {
    proposal = current.map((c) => ({ pid: c.pid, email: c.email, score: null }));
  }

  return {
    source: opts.source,
    papers,
    people,
    proposal,
    current,
    invites: inv.run ? { runId: inv.run.id, rows: inv.rows } : undefined,
    doNotInvite: dni.run ? { runId: dni.run.id, rows: dni.rows } : undefined,
    ...(tpmsRunId !== undefined ? { tpmsRunId } : {}),
    ...(opts.coauthors ? { coauthors: opts.coauthors } : {}),
  };
}
