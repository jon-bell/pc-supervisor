// Build the tracker's input from the local store and the refcheck import (no
// HotCRP calls): live papers with decision and tags, their ACs (PCS_AC_ROLE),
// the non-meta reviews in the quick-reject round with the verdict field pulled
// out in SQL, and the latest refcheck import as of `at`. No review text.

import type { AcRole, QuickRejectPolicy } from "../../config.js";
import { rowsAsOf } from "../../imports/store.js";
import type { Store } from "../../store/store.js";
import { scoreNumber } from "../../views/snapshot.js";
import type { QrInput, QrInputPaper, QrInputReview } from "./types.js";

export function loadQrInput(
  store: Store,
  cfg: { acRole: AcRole; policy: QuickRejectPolicy; due: Date | undefined },
  at: Date,
): QrInput {
  const db = store.db;
  const acs = new Map<number, string[]>();
  for (const a of store.areaChairs(cfg.acRole)) acs.set(a.pid, [...(acs.get(a.pid) ?? []), a.email]);

  const papers: QrInputPaper[] = (
    db.prepare("select pid, title, decision, tags from paper where deleted_seen_at is null order by pid").all() as {
      pid: number;
      title: string | null;
      decision: string | null;
      tags: string;
    }[]
  ).map((r) => ({
    pid: r.pid,
    title: r.title ?? "",
    decision: r.decision,
    tags: JSON.parse(r.tags) as string[],
    acs: acs.get(r.pid) ?? [],
  }));

  const reviews: QrInputReview[] = (
    db
      .prepare(
        `select rid, pid, email, status, json_extract(scores, ?) as value from review
          where deleted_seen_at is null and (rtype is null or rtype != 5) and lower(round) = lower(?)
          order by pid, rid`,
      )
      .all(`$.${cfg.policy.field}`, cfg.policy.round) as { rid: number; pid: number; email: string; status: string; value: unknown }[]
  ).map((r) => ({ rid: r.rid, pid: r.pid, email: r.email, status: r.status, value: scoreNumber(r.value) }));

  const rc = rowsAsOf(db, "refcheck", at);
  return {
    papers,
    reviews,
    refcheck: rc.run ? { runId: rc.run.id, rows: rc.rows } : undefined,
    due: cfg.due ? cfg.due.getTime() : null,
    now: at.getTime(),
  };
}
