// Small builders for rules-engine fixtures (synthetic data only).

import { fixedClock } from "../../src/clock.js";
import { loadConfig } from "../../src/config.js";
import { ruleContextFromConfig, type RuleContext } from "../../src/rules/context.js";
import type {
  CommentView,
  Millis,
  PaperView,
  ReviewStatus,
  ReviewVersionView,
  ReviewView,
} from "../../src/rules/model.js";
import { DAY_MS } from "../../src/rules/phase.js";
import { parseInstant } from "../../src/tz.js";

export const TZ = "America/New_York";

/** Phase dates from .github/workflows/ci.yml (the golden scenario's). */
export const PHASE_ENV: Record<string, string> = {
  PCS_TZ: TZ,
  PCS_PHASE_REVIEW_DUE: "2030-02-01T23:59",
  PCS_PHASE_RESPONSE_OPEN: "2030-02-08T00:00",
  PCS_PHASE_RESPONSE_CLOSE: "2030-02-11T23:59",
  PCS_PHASE_DISCUSSION_OPEN: "2030-02-12T00:00",
  PCS_PHASE_DISCUSSION_CLOSE: "2030-03-01T23:59",
  PCS_PHASE_DECISIONS_DUE: "2030-03-03T23:59",
};

export const RULES_ENV: Record<string, string> = {
  NODE_ENV: "test",
  PCS_HOTCRP_URL: "http://127.0.0.1:8080",
  PCS_HOTCRP_TOKEN: "hct_unitTestTokenNotReal0123456789",
  ...PHASE_ENV,
};

/** A local time in PCS_TZ ("2030-02-26T12:00") as epoch ms. */
export function at(local: string): Millis {
  const d = parseInstant(local, TZ);
  if (!d) throw new Error(`bad fixture time ${local}`);
  return d.getTime();
}

export const DISCUSSION_OPEN = at("2030-02-12T00:00");

/** Discussion day +d (fractional allowed), at `hour` local time. */
export function day(d: number, hour = 12): Millis {
  return DISCUSSION_OPEN + d * DAY_MS + hour * 3_600_000;
}

/** A rule context at a local instant, built through the real config loader. */
export function contextAt(nowLocal: string | Millis, extraEnv: Record<string, string> = {}): RuleContext {
  const cfg = loadConfig({ ...RULES_ENV, ...extraEnv });
  const now = typeof nowLocal === "number" ? nowLocal : at(nowLocal);
  return ruleContextFromConfig(cfg, fixedClock(new Date(now)));
}

export function paper(pid: number, over: Partial<PaperView> = {}): PaperView {
  return { pid, title: `Synthetic paper ${pid}`, decision: null, decisionSeenAt: null, tags: [], ...over };
}

export interface ReviewOpts {
  rid: number;
  pid: number;
  email: string;
  merit?: number | null;
  expertise?: number | null;
  words?: number;
  status?: ReviewStatus;
  rtype?: number;
  ordinal?: string | null;
  submittedAt?: Millis;
  /** Merit changes after submission: [{at, to}]. */
  moves?: { at: Millis; merit?: number; expertise?: number }[];
  ratedShort?: boolean;
  ratedVague?: boolean;
  modifiedAt?: Millis | null;
}

export function review(o: ReviewOpts): ReviewView {
  const status = o.status ?? "complete";
  const submitted = status === "complete" || status === "approved" || status === "delivered";
  const merit = o.merit === undefined ? 3 : o.merit;
  const expertise = o.expertise === undefined ? 3 : o.expertise;
  const subAt = o.submittedAt ?? at("2030-01-25T10:00");
  const assignedAt = at("2030-01-05T09:00");
  const versions: ReviewVersionView[] = submitted
    ? [{ seenAt: subAt, merit, expertise, status }]
    : [{ seenAt: assignedAt, merit: null, expertise: null, status }];
  let curMerit = merit;
  let curExp = expertise;
  let lastMod: Millis | null = submitted ? subAt : null;
  for (const m of o.moves ?? []) {
    curMerit = m.merit ?? curMerit;
    curExp = m.expertise ?? curExp;
    versions.push({ seenAt: m.at, merit: curMerit, expertise: curExp, status });
    lastMod = m.at;
  }
  return {
    rid: o.rid,
    pid: o.pid,
    email: o.email,
    rtype: o.rtype ?? 2,
    status,
    ordinal: o.ordinal === undefined ? (submitted ? "A" : null) : o.ordinal,
    merit: submitted ? curMerit : null,
    expertise: submitted ? curExp : null,
    wordCount: submitted ? (o.words ?? 250) : 0,
    ratedShort: o.ratedShort ?? false,
    ratedVague: o.ratedVague ?? false,
    modifiedAt: o.modifiedAt === undefined ? lastMod : o.modifiedAt,
    firstSeenAt: assignedAt,
    firstCompleteSeenAt: submitted ? subAt : null,
    versions,
  };
}

export interface CommentOpts {
  cid: number;
  pid: number;
  email: string;
  time: Millis;
  mentions?: string[];
  isResponse?: boolean;
  draft?: boolean;
  words?: number;
}

export function comment(o: CommentOpts): CommentView {
  return {
    cid: o.cid,
    pid: o.pid,
    email: o.email,
    isResponse: o.isResponse ?? false,
    draft: o.draft ?? false,
    visibility: o.isResponse ? "au" : "rev",
    wordCount: o.words ?? 80,
    mentions: o.mentions ?? [],
    time: o.time,
    approximate: false,
  };
}
