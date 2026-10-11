// The scenario's intended HotCRP state, computed by replaying its events.
// Pure (no I/O): the driver uses it to plan writes, the verifier compares it
// with what the API returns, and unit tests check it directly.

import {
  DEFAULT_REQUESTED_AT,
  objectKey,
  type AssignRole,
  type Scenario,
  type ScenarioEvent,
  type Scores,
  type Visibility,
} from "./format.js";
import { commentText, reviewText } from "./text.js";
import { describeWhen, resolveWhen, type PhaseContext } from "./time.js";
import { countRatings, isRatingFlag, type RatingCounts, type RatingFlag } from "@pcs/server/ratings";

export interface ReviewVersion {
  scores: Scores;
  at: Date;
}

export interface ExpectedReview {
  pid: number;
  email: string;
  role: AssignRole;
  requestedAt: Date;
  status: "empty" | "complete";
  /** Current scores (undefined while empty). */
  scores?: Scores;
  /** Text fields by UID (undefined while empty). */
  text?: Record<string, string>;
  words?: number;
  submittedAt?: Date;
  /** reviewModified: the last save (submission or score change). */
  modifiedAt?: Date;
  /** Every saved version, oldest first. */
  versions: ReviewVersion[];
  /** Unassigned (clearreview) by the end of the replayed stages. */
  removed: boolean;
  /** Review ratings: rater email -> their flags (rate events; a later one replaces). */
  ratings: Map<string, readonly RatingFlag[]>;
}

/** A review's ratings as HotCRP's /reviews aggregates them: raters per flag. */
export function ratingCounts(r: Pick<ExpectedReview, "ratings">): RatingCounts {
  return countRatings([...r.ratings.values()].flat());
}

export interface ExpectedComment {
  key: string;
  pid: number;
  email: string;
  response: boolean;
  visibility: Visibility | "au";
  mentions: string[];
  text: string;
  createdAt: Date;
  modifiedAt: Date;
  edits: number;
  deleted: boolean;
}

export interface ExpectedState {
  reviews: Map<string, ExpectedReview>;
  comments: Map<string, ExpectedComment>;
  decisions: Map<number, string>;
}

export const reviewKey = (pid: number, email: string) => `${pid}:${email.toLowerCase()}`;

export class ScenarioError extends Error {
  constructor(scenario: string, message: string) {
    super(`scenario ${scenario}: ${message}`);
    this.name = "ScenarioError";
  }
}

export interface TimedEvent {
  event: ScenarioEvent;
  time: Date;
  stage: number;
  /** Position in the scenario (stable tie-break). */
  index: number;
}

/** A stage's events with resolved times, sorted by time (stable). */
export function timedEvents(scenario: Scenario, ctx: PhaseContext, stage: number): TimedEvent[] {
  const st = scenario.stages[stage - 1];
  if (!st) throw new ScenarioError(scenario.name, `has no stage ${stage}`);
  return st.events
    .map((event, index) => ({ event, time: resolveWhen(event.at, ctx), stage, index }))
    .sort((a, b) => a.time.getTime() - b.time.getTime() || a.index - b.index);
}

/** Groups of events such that each object is touched at most once per wave, in time order. */
export function planWaves(events: readonly TimedEvent[]): TimedEvent[][] {
  const touches = new Map<string, number>();
  const waves: TimedEvent[][] = [];
  for (const te of events) {
    const k = objectKey(te.event);
    const w = touches.get(k) ?? 0;
    touches.set(k, w + 1);
    (waves[w] ??= []).push(te);
  }
  return waves;
}

/** Display name used for @mentions. */
export function mentionName(p: { first: string; last: string }): string {
  return `${p.first} ${p.last}`;
}

/**
 * Validate the scenario and replay stages 1..upToStage. Throws ScenarioError
 * on anything the driver could not reproduce faithfully.
 */
export function replay(scenario: Scenario, ctx: PhaseContext, upToStage = scenario.stages.length): ExpectedState {
  const fail = (m: string): never => {
    throw new ScenarioError(scenario.name, m);
  };
  if (scenario.stages.length === 0) fail("needs at least one stage");
  if (upToStage < 1 || upToStage > scenario.stages.length) fail(`has no stage ${upToStage}`);

  const people = new Map(scenario.people.map((p) => [p.email.toLowerCase(), p]));
  if (people.size !== scenario.people.length) fail("duplicate person email");
  for (const p of scenario.people) {
    if (!/^[^@\s]+@example\.org$/.test(p.email)) fail(`${p.email}: emails must be @example.org`);
  }
  const papers = new Map(scenario.papers.map((p) => [p.pid, p]));
  if (papers.size !== scenario.papers.length) fail("duplicate pid");
  const fieldDefs = new Map((scenario.submissionFields ?? []).map((f) => [f.name, f]));
  if (fieldDefs.size !== (scenario.submissionFields ?? []).length) fail("duplicate submission field name");
  const rounds = new Set(scenario.reviewRounds ?? []);
  for (const p of scenario.papers) {
    if (p.authors.length === 0) fail(`paper ${p.pid} has no authors`);
    for (const a of p.authors) {
      if (!/^[^@\s]+@example\.org$/.test(a.email)) fail(`${a.email}: emails must be @example.org`);
    }
    for (const [name, value] of Object.entries(p.options ?? {})) {
      const f = fieldDefs.get(name) ?? fail(`paper ${p.pid}: option ${JSON.stringify(name)} is not in submissionFields`);
      if (f.type === "dropdown" && !(f.values ?? []).includes(value)) fail(`paper ${p.pid}: ${JSON.stringify(value)} is not a value of ${name}`);
    }
  }
  const authorsOf = new Map(scenario.papers.map((p) => [p.pid, new Set(p.authors.map((a) => a.email.toLowerCase()))]));
  for (const p of scenario.papers) {
    if (p.lead === undefined) continue;
    if (!people.get(p.lead.toLowerCase())?.roles.includes("pc")) fail(`paper ${p.pid}: lead ${p.lead} is not on the PC`);
    if (authorsOf.get(p.pid)?.has(p.lead.toLowerCase())) fail(`paper ${p.pid}: lead ${p.lead} is one of its authors`);
  }
  const scoreFields = scenario.scoreFields ?? ["OveMer", "RevExp"];

  const state: ExpectedState = { reviews: new Map(), comments: new Map(), decisions: new Map() };
  for (const a of scenario.assignments) {
    const p = people.get(a.email.toLowerCase());
    if (!papers.has(a.pid)) fail(`assignment to unknown paper ${a.pid}`);
    if (!p || !p.roles.includes("pc")) fail(`assignment to ${a.email}, who is not on the PC`);
    if (authorsOf.get(a.pid)?.has(a.email.toLowerCase())) fail(`${a.email} is an author of paper ${a.pid} and can't review it`);
    if (a.round !== undefined && !rounds.has(a.round)) fail(`assignment round ${JSON.stringify(a.round)} is not in reviewRounds`);
    const k = reviewKey(a.pid, a.email);
    if (state.reviews.has(k)) fail(`${a.email} assigned twice to paper ${a.pid}`);
    state.reviews.set(k, {
      pid: a.pid,
      email: a.email.toLowerCase(),
      role: a.role,
      requestedAt: resolveWhen(a.requestedAt ?? DEFAULT_REQUESTED_AT, ctx),
      status: "empty",
      versions: [],
      removed: false,
      ratings: new Map(),
    });
  }

  const lastTouch = new Map<string, Date>();
  let prevStageEnd: Date | undefined;
  for (let s = 1; s <= upToStage; s++) {
    const stage = scenario.stages[s - 1]!;
    const now = stage.now ? resolveWhen(stage.now, ctx) : undefined;
    for (const te of timedEvents(scenario, ctx, s)) {
      const e = te.event;
      const where = `stage ${s} ${e.type} at ${describeWhen(e.at)}`;
      if (now && te.time > now) fail(`${where} is after the stage's now (${describeWhen(stage.now!)})`);
      if (prevStageEnd && te.time <= prevStageEnd) fail(`${where} is not after the previous stage`);
      const ok = objectKey(e);
      const last = lastTouch.get(ok);
      if (last && te.time <= last) fail(`${where}: events on one object must be strictly later than the previous one`);
      lastTouch.set(ok, te.time);
      applyEvent(e, te.time, where);
    }
    prevStageEnd = now ?? lastEventTime(scenario, ctx, s) ?? prevStageEnd;
  }
  return state;

  function scoresOk(scores: Scores, where: string) {
    for (const f of scoreFields) if (typeof scores[f] !== "number") fail(`${where}: missing score ${f}`);
  }

  function applyEvent(e: ScenarioEvent, t: Date, where: string): void {
    switch (e.type) {
      case "assign": {
        const p = people.get(e.email.toLowerCase());
        if (!papers.has(e.pid)) fail(`${where}: unknown paper ${e.pid}`);
        if (!p || !p.roles.includes("pc")) fail(`${where}: ${e.email} is not on the PC`);
        if (authorsOf.get(e.pid)?.has(e.email.toLowerCase())) fail(`${where}: ${e.email} is an author of paper ${e.pid} and can't review it`);
        const k = reviewKey(e.pid, e.email);
        if (state.reviews.has(k)) fail(`${where}: ${e.email} is already assigned to paper ${e.pid}`);
        state.reviews.set(k, { pid: e.pid, email: e.email.toLowerCase(), role: e.role, requestedAt: t, status: "empty", versions: [], removed: false, ratings: new Map() });
        return;
      }
      case "review": {
        const r = state.reviews.get(reviewKey(e.pid, e.email)) ?? fail(`${where}: ${e.email} is not assigned to ${e.pid}`);
        if (r.removed) fail(`${where}: review was unassigned`);
        if (r.status === "complete") fail(`${where}: already submitted (use scoreChange)`);
        if (t <= r.requestedAt) fail(`${where}: before the review was requested`);
        if (r.role !== "metareview") scoresOk(e.scores, where);
        r.status = "complete";
        r.scores = { ...e.scores };
        r.words = e.words;
        r.text = reviewText(reviewKey(e.pid, e.email), e.words);
        r.submittedAt = t;
        r.modifiedAt = t;
        r.versions.push({ scores: { ...e.scores }, at: t });
        return;
      }
      case "scoreChange": {
        const r = state.reviews.get(reviewKey(e.pid, e.email)) ?? fail(`${where}: ${e.email} is not assigned to ${e.pid}`);
        if (r.status !== "complete") fail(`${where}: review is not submitted yet`);
        r.scores = { ...r.scores, ...e.scores };
        r.modifiedAt = t;
        r.versions.push({ scores: { ...r.scores }, at: t });
        return;
      }
      case "unassign": {
        const r = state.reviews.get(reviewKey(e.pid, e.email)) ?? fail(`${where}: ${e.email} is not assigned to ${e.pid}`);
        if (r.removed) fail(`${where}: already unassigned`);
        if (r.status === "complete") fail(`${where}: unassign only unsubmitted reviews`);
        r.removed = true;
        return;
      }
      case "comment":
      case "response": {
        if (state.comments.has(e.key)) fail(`${where}: duplicate comment key ${e.key}`);
        const paper = papers.get(e.pid) ?? fail(`${where}: unknown paper ${e.pid}`);
        const author = e.email.toLowerCase();
        let mentions: string[] = [];
        let names: string[] = [];
        if (e.type === "response") {
          if (!paper.authors.some((a) => a.email.toLowerCase() === author)) fail(`${where}: ${e.email} is not an author`);
          if ([...state.comments.values()].some((c) => c.pid === e.pid && c.response && !c.deleted)) {
            fail(`${where}: paper ${e.pid} already has a response`);
          }
        } else {
          const p = people.get(author);
          if (!p || !p.roles.includes("pc")) fail(`${where}: ${e.email} is not on the PC`);
          mentions = (e.mentions ?? []).map((m) => m.toLowerCase());
          names = mentions.map((m) => mentionName(people.get(m) ?? fail(`${where}: mentions unknown ${m}`)));
        }
        const words = e.words ?? (e.type === "response" ? 120 : 40);
        state.comments.set(e.key, {
          key: e.key,
          pid: e.pid,
          email: author,
          response: e.type === "response",
          visibility: e.type === "response" ? "au" : (e.visibility ?? "rev"),
          mentions,
          text: commentText(e.key, 0, names, words, e.type === "comment" ? e.text : undefined),
          createdAt: t,
          modifiedAt: t,
          edits: 0,
          deleted: false,
        });
        return;
      }
      case "commentEdit": {
        const c = state.comments.get(e.key) ?? fail(`${where}: unknown comment ${e.key}`);
        if (c.deleted) fail(`${where}: comment ${e.key} was deleted`);
        c.edits++;
        const names = c.mentions.map((m) => mentionName(people.get(m)!));
        c.text = commentText(e.key, c.edits, names, e.words ?? 50);
        c.modifiedAt = t;
        return;
      }
      case "commentDelete": {
        const c = state.comments.get(e.key) ?? fail(`${where}: unknown comment ${e.key}`);
        if (c.deleted) fail(`${where}: comment ${e.key} already deleted`);
        c.deleted = true;
        return;
      }
      case "decision":
        if (!papers.has(e.pid)) fail(`${where}: unknown paper ${e.pid}`);
        state.decisions.set(e.pid, e.decision);
        return;
      case "rate": {
        const r = state.reviews.get(reviewKey(e.pid, e.email)) ?? fail(`${where}: ${e.email} is not assigned to ${e.pid}`);
        if (r.removed || r.status !== "complete") fail(`${where}: ${e.email}'s review on ${e.pid} is not submitted`);
        const rater = e.rater.toLowerCase();
        if (rater === r.email) fail(`${where}: nobody can rate their own review`);
        const p = people.get(rater);
        if (!p || !p.roles.includes("pc")) fail(`${where}: rater ${e.rater} is not on the PC`);
        const noReview = `${where}: rater ${e.rater} has no review on paper ${e.pid} (raters are co-reviewers or the metareviewer)`;
        const own = state.reviews.get(reviewKey(e.pid, rater)) ?? fail(noReview);
        if (own.removed) fail(noReview);
        if (own.role !== "metareview" && (own.status !== "complete" || own.submittedAt! >= t)) {
          fail(`${where}: rater ${e.rater} must submit their own review on ${e.pid} first`);
        }
        if (e.flags.length === 0) fail(`${where}: no flags`);
        for (const f of e.flags) if (!isRatingFlag(f)) fail(`${where}: unknown rating flag ${JSON.stringify(f)}`);
        if (new Set(e.flags).size !== e.flags.length) fail(`${where}: duplicate flag`);
        r.ratings.set(rater, [...e.flags]);
        return;
      }
    }
  }
}

function lastEventTime(scenario: Scenario, ctx: PhaseContext, stage: number): Date | undefined {
  const evs = timedEvents(scenario, ctx, stage);
  return evs.length > 0 ? evs[evs.length - 1]!.time : undefined;
}
