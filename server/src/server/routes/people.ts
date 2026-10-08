// GET /api/people/:email: the person page (spec §5a). Every paper they review
// or chair, their score there, their last comment, and their open pings, plus
// their reviewer summary and (if they chair papers) their AC row.
//
// One pass over the analysis' per-paper facts (O(papers)), plus one indexed
// comment_text read per paper they last commented on (for the excerpt).

import type { FastifyInstance } from "fastify";
import { isSubmitted } from "../../rules/facts.js";
import type { CommentView } from "../../rules/model.js";
import { OUTLIER_LISTS } from "../../rules/reviewer-metrics.js";
import type { OpenPing, OutlierListId, PersonPaper, PersonResponse } from "../api-types.js";
import { personOf, type RouteDeps } from "../app.js";
import { acRow } from "./acs.js";

const EXCERPT_CHARS = 200;
const EMAIL = /^[^\s@/]{1,128}@[^\s@/]{1,255}$/;

function excerpt(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= EXCERPT_CHARS ? t : `${t.slice(0, EXCERPT_CHARS - 1).trimEnd()}…`;
}

export function registerPeople(app: FastifyInstance, deps: RouteDeps): void {
  const lastText = deps.store.db.prepare("select text from comment_text where cid = ? order by id desc limit 1");

  app.get<{ Params: { email: string } }>("/api/people/:email", async (req, reply) => {
    const email = req.params.email.trim().toLowerCase();
    if (!EMAIL.test(email)) return reply.code(400).send({ error: "expected an email address" });
    const view = deps.analysis.get();
    const { analysis, people, ctx } = view;
    const ev = analysis.evaluation;
    const rm = analysis.reviewers.find((r) => r.email === email) ?? null;
    const am = analysis.acs.find((a) => a.email === email) ?? null;
    const pv = people.get(email);
    if (!pv && !rm && !am) return reply.code(404).send({ error: "no such person in the local store" });

    const silent = new Set(rm?.silentOnSplit ?? []);
    const outstanding = new Set(rm?.outstanding ?? []);
    const thin = new Set(rm?.depth.flaggedPids ?? []);
    const unanswered = new Set(rm?.responsiveness.unanswered.map((u) => u.pid) ?? []);
    const ratingFlagged = new Set(rm?.ratings?.negativePids ?? []);
    const ratingsEnabled = ev.index.ratingsEnabled;

    const papers: PersonPaper[] = [];
    for (const f of ev.facts.values()) {
      const isAc = f.acSet.has(email);
      const own = f.bundle.reviews.filter((r) => r.email === email);
      if (!isAc && own.length === 0) continue;
      const result = ev.byPid.get(f.pid);
      const r = (isAc ? own : own.filter((x) => f.reviewerReviews.includes(x)))[0] ?? own[0] ?? null;
      const mine: CommentView[] = f.pcComments.filter((c) => c.email === email);
      const last = mine.length ? mine[mine.length - 1]! : null;
      const lastRow = last ? (lastText.get(last.cid) as { text: string } | undefined) : undefined;
      papers.push({
        pid: f.pid,
        title: f.bundle.paper.title,
        decision: f.bundle.paper.decision,
        role: isAc ? "AC" : "reviewer",
        review: r
          ? {
              rid: r.rid,
              ordinal: r.ordinal,
              status: r.status,
              submitted: isSubmitted(r),
              merit: r.merit,
              expertise: r.expertise,
              wordCount: r.wordCount,
              ratings: ratingsEnabled ? { ...r.ratings } : null,
            }
          : null,
        merits: [...f.merits],
        comments: mine.length,
        discussionComments: mine.filter((c) => c.time >= ctx.phases.discussionOpen).length,
        lastComment: last
          ? { cid: last.cid, time: last.time, approximate: last.approximate, wordCount: last.wordCount, excerpt: excerpt(lastRow?.text ?? "") }
          : null,
        rules: result?.fired.map((x) => x.rule) ?? [],
        severity: result?.severity ?? 0,
        flags: {
          silentOnSplit: silent.has(f.pid),
          outstanding: outstanding.has(f.pid),
          thin: thin.has(f.pid),
          unansweredPing: unanswered.has(f.pid),
          ratingFlagged: ratingFlagged.has(f.pid),
        },
      });
    }
    papers.sort((a, b) => (a.role === b.role ? a.pid - b.pid : a.role === "AC" ? -1 : 1));

    const openPings: OpenPing[] = (rm?.responsiveness.open ?? []).map((p) => ({
      pid: p.pid,
      title: ev.facts.get(p.pid)?.bundle.paper.title ?? "",
      since: p.since,
      ageDays: p.ageDays,
      pings: p.pings,
      mentionedAt: p.mentionedAt,
      overThreshold: p.ageDays > ctx.thresholds.PING_DAYS,
    }));

    const outliers: OutlierListId[] = OUTLIER_LISTS.filter((l) =>
      Object.values(analysis.outliers[l]).some((entries) => entries.some((e) => e.email === email)),
    );

    const body: PersonResponse = {
      now: ctx.now,
      person: { ...personOf(people, email), roles: [...(pv?.roles ?? [])] },
      pingDays: ctx.thresholds.PING_DAYS,
      reviewer: rm
        ? {
            assigned: rm.assigned,
            submitted: rm.submitted,
            outstanding: [...rm.outstanding],
            late: rm.late,
            depth: {
              medianWords: rm.depth.medianWords,
              pcMedianWords: rm.depth.pcMedianWords,
              thin: rm.depth.thin,
              bottomDecile: rm.depth.bottomDecile,
              ratedThin: rm.depth.ratedThin,
            },
            ratings: rm.ratings
              ? {
                  received: { ...rm.ratings.received },
                  negative: rm.ratings.negative,
                  good: rm.ratings.good,
                  negativePids: [...rm.ratings.negativePids],
                  repeated: rm.ratings.repeated,
                }
              : null,
            participation: { ...rm.participation },
            responsiveness: { medianDays: rm.responsiveness.medianDays, answered: rm.responsiveness.answered },
            movement: { reviews: rm.movement.reviews, pids: [...rm.movement.pids] },
            silentOnSplit: [...rm.silentOnSplit],
          }
        : null,
      ac: am ? acRow(am, people) : null,
      outliers,
      papers,
      openPings,
    };
    return body;
  });
}
