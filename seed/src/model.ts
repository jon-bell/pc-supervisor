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
  for (const p of scenario.papers) {
    if (p.authors.length === 0) fail(`paper ${p.pid} has no authors`);
    for (const a of p.authors) {
      if (!/^[^@\s]+@example\.org$/.test(a.email)) fail(`${a.email}: emails must be @example.org`);
      if (people.get(a.email.toLowerCase())?.roles.length) fail(`${a.email}: PC members can't be authors here`);
    }
  }
  const scoreFields = scenario.scoreFields ?? ["OveMer", "RevExp"];

  const state: ExpectedState = { reviews: new Map(), comments: new Map(), decisions: new Map() };
  for (const a of scenario.assignments) {
    const p = people.get(a.email.toLowerCase());
    if (!papers.has(a.pid)) fail(`assignment to unknown paper ${a.pid}`);
    if (!p || !p.roles.includes("pc")) fail(`assignment to ${a.email}, who is not on the PC`);
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
          text: commentText(e.key, 0, names, words),
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
    }
  }
}

function lastEventTime(scenario: Scenario, ctx: PhaseContext, stage: number): Date | undefined {
  const evs = timedEvents(scenario, ctx, stage);
  return evs.length > 0 ? evs[evs.length - 1]!.time : undefined;
}
