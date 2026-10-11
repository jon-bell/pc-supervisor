// GET /api/papers/:pid: the paper drawer. Reviews with their observed
// versions and score changes, comments with author, word count and mentions,
// the author response, and full text from the local store, plus one
// timeline merging all of it (oldest first).
//
// Queries are per paper (this is one drawer): the store's pid-filtered reads
// plus one statement each for review and comment text.

import type { FastifyInstance } from "fastify";
import type { CommentDetail, PaperDetail, ReviewDetail, TimelineEvent, VersionInfo } from "../api-types.js";
import { personOf, type RouteDeps } from "../app.js";
import { scoreNumber } from "../../views/snapshot.js";
import { effectiveLabels } from "../../classifier/store.js";
import { commentType } from "./comments.js";

const SUBMITTED = new Set(["delivered", "approved", "complete"]);
const ms = (s: number | null) => (s === null ? null : s * 1000);

export function registerPapers(app: FastifyInstance, deps: RouteDeps): void {
  app.get<{ Params: { pid: string } }>("/api/papers/:pid", async (req, reply) => {
    if (!/^\d{1,9}$/.test(req.params.pid)) return reply.code(400).send({ error: "pid must be a positive integer" });
    const pid = Number(req.params.pid);
    const view = deps.analysis.get();
    const facts = view.analysis.evaluation.facts.get(pid);
    const result = view.analysis.evaluation.byPid.get(pid);
    if (!facts || !result) return reply.code(404).send({ error: `no paper #${pid} in the local store` });
    const { store, cfg } = deps;
    const people = view.people;
    const acSet = facts.acSet;
    const paper = facts.bundle.paper;

    const fieldName = new Map(store.reviewFields().map((f) => [f.uid, f.name]));
    const fieldOrder = new Map(store.reviewFields().map((f, i) => [f.uid, i]));
    const texts = new Map<number, { field: string; text: string; ord: number }[]>();
    for (const t of store.db
      .prepare(
        `select t.rid, t.field_uid, t.text from review_text t join review r on r.rid = t.rid and r.vtag = t.vtag
          where r.pid = ? and r.deleted_seen_at is null`,
      )
      .all(pid) as { rid: number; field_uid: string; text: string }[]) {
      const list = texts.get(t.rid) ?? [];
      list.push({ field: fieldName.get(t.field_uid) ?? t.field_uid, text: t.text, ord: fieldOrder.get(t.field_uid) ?? 999 });
      texts.set(t.rid, list);
    }

    const timeline: TimelineEvent[] = [];
    const reviews: ReviewDetail[] = store.reviewsWithHistory({ pids: [pid] }).map((r) => {
      const versions: VersionInfo[] = r.versions.map((v) => ({
        at: ms(v.at),
        source: v.source,
        status: v.status,
        merit: scoreNumber(v.scores[cfg.fields.merit]),
        expertise: scoreNumber(v.scores[cfg.fields.expertise]),
        // HotCRP's modified_at is exact; otherwise we only know when a sync saw it.
        approximate: v.modifiedAt === null,
      }));
      const firstSubmitted = versions.find((v) => SUBMITTED.has(v.status) && v.at !== null);
      const submittedAt = firstSubmitted?.at ?? (SUBMITTED.has(r.status) ? ms(r.modifiedAt ?? r.firstCompleteSeenAt) : null);
      if (submittedAt !== null) {
        timeline.push({ kind: "review", at: submittedAt, approximate: firstSubmitted ? firstSubmitted.approximate : r.firstCompleteApprox, rid: r.rid });
      }
      for (let i = 1; i < versions.length; i++) {
        const a = versions[i - 1]!;
        const b = versions[i]!;
        if (b.at === null) continue;
        for (const field of ["merit", "expertise"] as const) {
          const from = a[field];
          const to = b[field];
          if (from !== null && to !== null && from !== to) {
            timeline.push({ kind: "score", at: b.at, approximate: b.approximate, rid: r.rid, field, from, to });
          }
        }
      }
      return {
        rid: r.rid,
        ordinal: r.ordinal || null,
        reviewer: personOf(people, r.email),
        role: r.rtype === 5 || acSet.has(r.email) ? "AC" : "reviewer",
        rtype: r.rtype ?? 0,
        status: r.status,
        merit: scoreNumber(r.scores[cfg.fields.merit]),
        expertise: scoreNumber(r.scores[cfg.fields.expertise]),
        wordCount: r.wordCount,
        ratings: view.analysis.evaluation.index.ratingsEnabled ? { ...r.ratings } : null,
        modifiedAt: ms(r.modifiedAt),
        submittedAt,
        approximate: r.firstSeenApprox,
        versions,
        text: (texts.get(r.rid) ?? []).sort((x, y) => x.ord - y.ord).map(({ field, text }) => ({ field, text })),
      };
    });

    const commentText = new Map<number, string>();
    for (const t of store.db
      .prepare(
        `select t.cid, t.text from comment_text t
          where t.id in (select max(x.id) from comment_text x join comment c on c.cid = x.cid where c.pid = ? group by x.cid)`,
      )
      .all(pid) as { cid: number; text: string }[]) {
      commentText.set(t.cid, t.text);
    }
    const modified = new Map(store.comments({ pids: [pid] }).map((c) => [c.cid, c.modifiedAt]));
    const reviewerEmails = new Set(facts.reviewerReviews.map((r) => r.email));
    const typesOn = (cfg.commentClassifier?.mode ?? "heuristic") !== "off";
    const labels = typesOn ? effectiveLabels(store.db, facts.bundle.comments.map((c) => c.cid)) : new Map();
    const minConfidence = cfg.commentClassifier?.minConfidence ?? 0.6;
    const comments: CommentDetail[] = facts.bundle.comments.map((c) => {
      const mod = ms(modified.get(c.cid) ?? null);
      timeline.push({ kind: c.isResponse ? "response" : "comment", at: c.time, approximate: c.approximate, cid: c.cid });
      return {
        cid: c.cid,
        author: personOf(people, c.email),
        role: c.isResponse ? "author" : acSet.has(c.email) ? "AC" : reviewerEmails.has(c.email) ? "reviewer" : "other",
        isResponse: c.isResponse,
        draft: c.draft,
        visibility: c.visibility,
        wordCount: c.wordCount,
        mentions: c.mentions.map((e) => personOf(people, e)),
        time: c.time,
        approximate: c.approximate,
        // Edited: HotCRP's modified_at is more than a minute past the first time we know of.
        editedAt: mod !== null && mod - c.time > 60_000 ? mod : null,
        text: commentText.get(c.cid) ?? "",
        type: c.isResponse || c.draft ? null : commentType(labels.get(c.cid), minConfidence),
      };
    });
    if (paper.decision !== null && paper.decisionSeenAt !== null) {
      const row = store.papers({ pids: [pid] })[0];
      timeline.push({ kind: "decision", at: paper.decisionSeenAt, approximate: row?.decisionSeenApprox ?? true, decision: paper.decision });
    }
    const order: Record<TimelineEvent["kind"], number> = { review: 0, score: 1, response: 2, comment: 3, decision: 4 };
    const id = (e: TimelineEvent) => ("rid" in e ? e.rid : "cid" in e ? e.cid : 0);
    timeline.sort((a, b) => a.at - b.at || order[a.kind] - order[b.kind] || id(a) - id(b));

    const body: PaperDetail = {
      now: view.ctx.now,
      pid,
      title: paper.title,
      decision: paper.decision,
      tags: [...paper.tags],
      acs: facts.bundle.acs.map((e) => personOf(people, e)),
      severity: result.severity,
      reasons: result.fired.map((x) => ({ rule: x.rule, weight: x.weight, reason: x.reason })),
      lastActivity: result.lastActivity,
      reviews,
      comments,
      timeline,
    };
    return body;
  });
}
