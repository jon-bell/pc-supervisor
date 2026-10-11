// Why a flag changed, in a few words (the paper flag timeline: "cleared
// Feb 24 after AC comment"). Pure, over the paper's current bundle.
//
// - cause 'rules': "after rule change #N";
// - cause 'baseline': "already flagged when history began";
// - cause 'data': the latest activity in (since, at] on that paper: a
//   comment (by an AC, a reviewer, or someone else; with its type when the
//   comment classifier labelled it), the author response, a
//   review submission, a merit change, or the decision. None found (e.g. a
//   paper going quiet just by time passing): null.

import { isSubmitted, type PaperBundle } from "../rules/facts.js";
import type { FlagEvent } from "./flags.js";
import type { CommentKind } from "../classifier/kinds.js";

const KIND_WORD: Readonly<Record<CommentKind, string>> = { ping: "ping", reply: "reply", discussion: "discussion", nonsubstantive: "non-substantive" };

export function explainEvent(e: Pick<FlagEvent, "cause" | "revisionId" | "since" | "at">, b: PaperBundle | undefined): string | null {
  if (e.cause === "rules") return e.revisionId ? `after rule change #${e.revisionId}` : "after a rule change";
  if (e.cause === "baseline") return "already flagged when history began";
  if (!b) return null;
  const lo = e.since ?? -Infinity;
  const hi = e.at;
  const inWindow = (t: number | null) => t !== null && t > lo && t <= hi;
  const acs = new Set(b.acs);
  let best: { t: number; what: string } | null = null;
  const consider = (t: number, what: string) => {
    if (!best || t >= best.t) best = { t, what };
  };
  for (const c of b.comments) {
    if (c.draft || !inWindow(c.time)) continue;
    if (c.isResponse) consider(c.time, "after the author response");
    else {
      const ac = acs.has(c.email) || b.reviews.some((r) => r.email === c.email && r.rtype === 5);
      const reviewer = b.reviews.some((r) => r.email === c.email && r.rtype !== 5);
      // With comment types (spec §5e), the type follows in brackets: "after AC comment (ping)".
      const kind = c.kind ? ` (${KIND_WORD[c.kind]})` : "";
      consider(c.time, `${ac ? "after AC comment" : reviewer ? "after reviewer comment" : "after a comment"}${kind}`);
    }
  }
  for (const r of b.reviews) {
    const v = r.versions;
    const firstSubmitted = v.find((x) => isSubmitted(x))?.seenAt ?? (v.length === 0 ? r.firstCompleteSeenAt : null);
    if (firstSubmitted !== null && firstSubmitted !== undefined && inWindow(firstSubmitted)) consider(firstSubmitted, r.rtype === 5 ? "after a metareview" : "after a review was submitted");
    for (let i = 1; i < v.length; i++) {
      const a = v[i - 1]!;
      const c = v[i]!;
      if (a.merit !== null && c.merit !== null && a.merit !== c.merit && inWindow(c.seenAt)) consider(c.seenAt, `after a merit change ${a.merit}→${c.merit}`);
    }
  }
  if (b.paper.decision !== null && inWindow(b.paper.decisionSeenAt)) consider(b.paper.decisionSeenAt!, "after the decision");
  return (best as { t: number; what: string } | null)?.what ?? null;
}
