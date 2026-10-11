// Flag history (spec §5c "Flag history", §6b API):
//   GET /api/flag-history            the feed of raises, clears and the chair's
//                                    tag writes, newest first, plus open-flag
//                                    counts over time. ?rule=A,B (any of),
//                                    ?search= (paper filter), ?before=<ms>
//                                    and ?limit= to page.
//   GET /api/papers/:pid/flag-history  one paper's flag spans and tag writes
// Reads only the store (flag_event, chair_action) and the cached analysis
// (titles and the "why" of each change).

import type { FastifyInstance } from "fastify";
import { RULE_NAMES, type RuleName } from "../../config.js";
import { chairActions, type ChairAction } from "../../history/chair-actions.js";
import { explainEvent } from "../../history/explain.js";
import { firstEventAt, flagEvents, flagSeries, historySince, intervalsOf, type FlagEvent } from "../../history/flags.js";
import { DAY_MS } from "../../rules/phase.js";
import type { ChairActionItem, FlagEventItem, FlagFeedItem, FlagHistoryResponse, PaperFlagHistoryResponse } from "../rules-types.js";
import type { AnalysisView } from "../analysis.js";
import type { RouteDeps } from "../app.js";
import { FilterError, filterOf, isFiltering } from "../paper-filter.js";

const MAX_LIMIT = 500;

function rulesParam(v: unknown): RuleName[] | null {
  if (typeof v !== "string" || v.trim() === "") return null;
  const xs = v.split(",").map((x) => x.trim());
  return xs.filter((x): x is RuleName => (RULE_NAMES as string[]).includes(x));
}

const titleOf = (view: AnalysisView, pid: number) => view.analysis.evaluation.index.byPid.get(pid)?.paper.title ?? "";

function eventItem(e: FlagEvent, view: AnalysisView): FlagEventItem {
  return {
    type: "flag",
    id: e.id,
    pid: e.pid,
    title: titleOf(view, e.pid),
    rule: e.rule,
    kind: e.kind,
    at: e.at,
    cause: e.cause,
    revisionId: e.revisionId,
    reconstructed: e.reconstructed,
    reason: e.reason,
    why: explainEvent(e, view.analysis.evaluation.index.byPid.get(e.pid)),
  };
}

function actionItem(a: ChairAction, view: AnalysisView): ChairActionItem {
  return { type: "action", id: a.id, pid: a.pid, title: titleOf(view, a.pid), kind: a.kind, tag: a.tag, at: a.at, actor: a.actor };
}

export function registerFlagHistory(app: FastifyInstance, deps: RouteDeps): void {
  app.get("/api/flag-history", async (req, reply) => {
    const q = req.query as Record<string, unknown>;
    let pids: readonly number[] | undefined;
    const f = filterOf(req);
    if (isFiltering(f)) {
      try {
        pids = await deps.paperFilter.resolve(f.search, f.t);
      } catch (e) {
        if (e instanceof FilterError) return reply.code(e.status).send({ error: e.message });
        throw e;
      }
    }
    const rules = rulesParam(q.rule);
    const limit = Math.min(MAX_LIMIT, /^\d{1,4}$/.test(String(q.limit ?? "")) ? Math.max(1, Number(q.limit)) : 200);
    const before = /^\d{1,15}$/.test(String(q.before ?? "")) ? Number(q.before) : undefined;
    const view = deps.analysis.get();
    const db = deps.store.db;

    const events = flagEvents(db, { pids, rules: rules ?? undefined, before, limit: limit + 1, order: "desc" });
    // Tag writes aren't per rule: shown unless a rule filter is on.
    const actions = rules ? [] : chairActions(db, { pids, before, limit: limit + 1 });
    const merged: FlagFeedItem[] = [...events.map((e) => eventItem(e, view)), ...actions.map((a) => actionItem(a, view))].sort(
      (a, b) => b.at - a.at || (a.type === b.type ? b.id - a.id : a.type === "action" ? -1 : 1),
    );
    const items = merged.slice(0, limit);

    // Series and summary from every collapsed event of the selected papers/rules.
    const all = flagEvents(db, { pids, rules: rules ?? undefined, order: "asc" });
    const now = view.ctx.now;
    const start = firstEventAt(db);
    const shown = rules ?? RULE_NAMES;
    const series = flagSeries(all, shown, start ?? now, now);
    const ivs = intervalsOf(all);
    const weekAgo = now - 7 * DAY_MS;
    const summary = shown.map((rule) => {
      const mine = ivs.filter((iv) => iv.rule === rule);
      return {
        rule,
        open: mine.filter((iv) => iv.cleared === null).length,
        raised7d: mine.filter((iv) => iv.raised.at > weekAgo).length,
        cleared7d: mine.filter((iv) => iv.cleared !== null && iv.cleared.at > weekAgo).length,
      };
    });
    const body: FlagHistoryResponse = { now, since: historySince(db), start, rules: shown, items, more: merged.length > limit, series, summary };
    return body;
  });

  app.get<{ Params: { pid: string } }>("/api/papers/:pid/flag-history", async (req, reply) => {
    if (!/^\d{1,9}$/.test(req.params.pid)) return reply.code(400).send({ error: "pid must be a positive integer" });
    const pid = Number(req.params.pid);
    const view = deps.analysis.get();
    const bundle = view.analysis.evaluation.index.byPid.get(pid);
    if (!bundle) return reply.code(404).send({ error: `no paper #${pid} in the local store` });
    const db = deps.store.db;
    const spans = intervalsOf(flagEvents(db, { pid, order: "asc" })).map((iv) => ({
      rule: iv.rule,
      raisedAt: iv.raised.at,
      clearedAt: iv.cleared?.at ?? null,
      raisedReconstructed: iv.raised.reconstructed,
      clearedReconstructed: iv.cleared?.reconstructed ?? false,
      raisedWhy: explainEvent(iv.raised, bundle),
      clearedWhy: iv.cleared ? explainEvent(iv.cleared, bundle) : null,
      reason: iv.raised.reason,
    }));
    const body: PaperFlagHistoryResponse = {
      pid,
      since: historySince(db),
      spans,
      actions: chairActions(db, { pid }).map((a) => actionItem(a, view)),
    };
    return body;
  });
}
