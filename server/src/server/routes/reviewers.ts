// GET /api/reviewers: the reviewer outlier lists (spec §5a), split by tier.
// A person appears in a list only when they cross its absolute bar
// (rules/reviewer-metrics.ts); nothing here is a rank. Within a tier, entries
// come in the server's order (count, then email); the UI can sort by name.

import type { FastifyInstance } from "fastify";
import { OUTLIER_LISTS, type OutlierList as RuleList } from "../../rules/reviewer-metrics.js";
import type { OutlierList, OutlierListId, ReviewersResponse } from "../api-types.js";
import { personOf, type RouteDeps } from "../app.js";

export const OUTLIER_LABELS: Readonly<Record<OutlierListId, { label: string; bar: (pingDays: number) => string }>> = {
  silentOnSplit: { label: "No comments yet on split papers", bar: () => "at least 1 split paper with no comment from them since discussion opened" },
  unansweredPings: { label: "Unanswered pings", bar: (d) => `at least 1 ping (an @mention or AC comment) unanswered for more than ${d} days` },
  late: { label: "Reviews not submitted", bar: () => "at least 1 assigned review not submitted after the review deadline" },
  thin: { label: "Short or flagged reviews", bar: () => "at least 1 review under the word minimum, in the PC's bottom decile, or rated short/vague" },
};

/** "senior" + configured tiers, then any other tier seen. */
export function tierOrder(configured: readonly string[], seen: Iterable<string>): string[] {
  const out = [...configured];
  for (const t of seen) if (!out.includes(t)) out.push(t);
  return out;
}

export function registerReviewers(app: FastifyInstance, deps: RouteDeps): void {
  app.get("/api/reviewers", async (): Promise<ReviewersResponse> => {
    const view = deps.analysis.get();
    const { outliers, reviewers } = view.analysis;
    const tiers = tierOrder(["senior", ...Object.keys(deps.cfg.tierTags)], reviewers.map((r) => r.tier));
    const pingDays = view.ctx.thresholds.PING_DAYS;
    const lists: OutlierList[] = OUTLIER_LISTS.map((id: RuleList) => {
      const byTier = tiers.map((tier) => ({
        tier,
        entries: (outliers[id][tier] ?? []).map((e) => ({
          person: personOf(view.people, e.email),
          count: e.count,
          pids: [...e.pids],
          detail: e.detail,
        })),
      }));
      return {
        id,
        label: OUTLIER_LABELS[id].label,
        bar: OUTLIER_LABELS[id].bar(pingDays),
        total: byTier.reduce((n, g) => n + g.entries.length, 0),
        byTier,
      };
    });
    return { now: view.ctx.now, reviewers: reviewers.length, tiers, lists };
  });
}
