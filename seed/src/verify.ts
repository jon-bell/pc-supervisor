// Check, through the read API only, that the harness holds exactly what a
// scenario intends after a given stage: papers, roster and tags, assignments,
// reviews (status, scores, text, modified_at), review history for score
// changes, comments (author, text, mentions, response, modified_at), and
// decisions. Times must match within ±TOLERANCE_S of the phase-relative
// intent. Uses the chair token from .env.test (PCS_HOTCRP_TOKEN).

import { loadHotcrpConfig } from "@pcs/server/config";
import { clientFromConfig, type HotcrpClient } from "@pcs/server/hotcrp/client";
import { assertHarnessUrl } from "@pcs/server/hotcrp/harness-guard";
import { reviewField, ReviewsSchema, submissionOptionValue, type Review } from "@pcs/server/hotcrp/schemas";
import { REVIEW_TEXT_FIELDS, type AssignRole, type Scenario } from "./format.js";
import { replay, reviewKey, type ExpectedState } from "./model.js";
import { epochSeconds, type PhaseContext } from "./time.js";

export const TOLERANCE_S = 60;
const MAX_HISTORY_CHECKS = 40;

const RTYPE: Record<AssignRole, number> = { metareview: 5, primary: 4, secondary: 3, pcreview: 2 };
const ACTION: Record<AssignRole, string> = {
  metareview: "metareview",
  primary: "primaryreview",
  secondary: "secondaryreview",
  pcreview: "pcreview",
};

type Env = Readonly<Record<string, string | undefined>>;

export function readClient(env: Env = process.env): HotcrpClient {
  assertHarnessUrl(env);
  return clientFromConfig(loadHotcrpConfig(env), { concurrency: 4 });
}

/** Reviewer emails holding user tag `tag`, via the review search `rq=re:#tag` (see spec §9.3). */
export async function reviewerEmailsWithTag(client: HotcrpClient, tag: string, q = "all"): Promise<Set<string>> {
  const res = await client.call({
    path: "reviews",
    params: { q, rq: `re:#${tag}`, forceShow: 1 },
    postAsGet: true,
    schema: ReviewsSchema,
  });
  return new Set(res.reviews.map((r) => (r.reviewer_email ?? "").toLowerCase()).filter((e) => e !== ""));
}

export interface VerifyResult {
  problems: string[];
  checks: number;
}

function near(actual: number | undefined, intended: Date): boolean {
  return actual !== undefined && Math.abs(actual - epochSeconds(intended)) <= TOLERANCE_S;
}

function iso(t: number | undefined): string {
  return t === undefined ? "(absent)" : new Date(t * 1000).toISOString();
}

export async function verifyScenario(
  scenario: Scenario,
  ctx: PhaseContext,
  stage: number = scenario.stages.length,
  client: HotcrpClient = readClient(),
): Promise<VerifyResult> {
  const expected: ExpectedState = replay(scenario, ctx, stage);
  const problems: string[] = [];
  let checks = 0;
  const check = (ok: boolean, msg: () => string) => {
    checks++;
    if (!ok) problems.push(msg());
  };
  const scoreFields = scenario.scoreFields ?? ["OveMer", "RevExp"];

  // Papers and decisions.
  const pids = scenario.papers.map((p) => p.pid).sort((a, b) => a - b);
  const search = await client.search({ t: "all", fields: ["decision", "status"] });
  check(JSON.stringify(search.ids) === JSON.stringify(pids), () => `papers: expected ${pids.length} (${pids.slice(0, 20).join(",")}), got ${search.ids.length}`);
  for (const p of search.papers ?? []) {
    const want = expected.decisions.get(p.pid) ?? "Unspecified";
    check(p.decision === want, () => `paper ${p.pid}: decision ${p.decision ?? "(none)"}, expected ${want}`);
    check(p.status !== "Not ready", () => `paper ${p.pid}: not submitted`);
  }

  // Authors (email, affiliation, order) and submission options (phase 2), via /papers.
  const details = new Map((await client.papers({ q: "all", t: "all" })).map((p) => [p.pid, p]));
  for (const sp of scenario.papers) {
    const d = details.get(sp.pid);
    check(d !== undefined, () => `paper ${sp.pid}: missing from /papers`);
    if (!d) continue;
    const got = (d.authors ?? []).map((a) => `${(a.email ?? "").toLowerCase()}|${a.affiliation ?? ""}`);
    const want = sp.authors.map((a) => `${a.email.toLowerCase()}|${a.affiliation ?? ""}`);
    check(JSON.stringify(got) === JSON.stringify(want), () => `paper ${sp.pid}: authors ${got.join(",")}, expected ${want.join(",")}`);
    for (const f of scenario.submissionFields ?? []) {
      const v = submissionOptionValue(d, f.name);
      const w = sp.options?.[f.name];
      check((v ?? undefined) === w, () => `paper ${sp.pid}: option ${f.name} is ${JSON.stringify(v)}, expected ${JSON.stringify(w)}`);
    }
  }

  // Roster: every PC person, with name; tags via the reviewer-tag review search.
  const pc = await client.pc();
  const roster = new Map(pc.pc.map((m) => [m.email.toLowerCase(), m]));
  for (const p of scenario.people.filter((x) => x.roles.includes("pc"))) {
    const m = roster.get(p.email.toLowerCase());
    check(m !== undefined, () => `pc: ${p.email} missing from /pc`);
    if (m) check(m.name === `${p.first} ${p.last}`, () => `pc: ${p.email} has name "${m.name}", expected "${p.first} ${p.last}"`);
  }
  // Only PC members' tags are visible this way (/pc lists no others; a non-PC
  // user's tag, e.g. reserve-pool, can't be queried).
  const tags = [...new Set(scenario.people.filter((p) => p.roles.includes("pc")).flatMap((p) => p.tags ?? []))].sort();
  const liveReviewers = new Set([...expected.reviews.values()].filter((r) => !r.removed).map((r) => r.email));
  for (const tag of tags) {
    const got = await reviewerEmailsWithTag(client, tag);
    const want = new Set(
      scenario.people.filter((p) => p.tags?.includes(tag) && liveReviewers.has(p.email.toLowerCase())).map((p) => p.email.toLowerCase()),
    );
    check(
      got.size === want.size && [...want].every((e) => got.has(e)),
      () => `tag ${tag}: reviewers ${[...got].sort().join(",") || "(none)"}, expected ${[...want].sort().join(",")}`,
    );
  }

  // Assignments.
  const rows = await client.pcAssignments({ t: "all" });
  const gotAssign = new Set(rows.filter((r) => r.action !== "clearreview").map((r) => `${r.paper}:${(r.email ?? "").toLowerCase()}:${r.action}`));
  const wantAssign = new Set([...expected.reviews.values()].filter((r) => !r.removed).map((r) => `${r.pid}:${r.email}:${ACTION[r.role]}`));
  for (const a of wantAssign) check(gotAssign.has(a), () => `assignment ${a} missing`);
  for (const a of gotAssign) check(wantAssign.has(a), () => `unexpected assignment ${a}`);
  // Review rounds (phase 2): HotCRP reports the round only for named rounds.
  const roundOf = new Map(rows.map((r) => [`${r.paper}:${(r.email ?? "").toLowerCase()}`, r.round ?? ""]));
  for (const a of scenario.assignments) {
    if (a.round === undefined) continue;
    const k = `${a.pid}:${a.email.toLowerCase()}`;
    check(roundOf.get(k) === a.round, () => `assignment ${k}: round ${JSON.stringify(roundOf.get(k))}, expected ${a.round}`);
  }

  // Reviews.
  const reviews = await client.reviewsForPids(pids, { t: "all" });
  const byKey = new Map<string, Review>();
  for (const r of reviews) byKey.set(reviewKey(r.pid, r.reviewer_email ?? `rid${r.rid}`), r);
  const wantReviews = [...expected.reviews.values()].filter((r) => !r.removed);
  check(reviews.length === wantReviews.length, () => `reviews: got ${reviews.length}, expected ${wantReviews.length}`);
  const historyChecks: { r: Review; versions: (typeof wantReviews)[number]["versions"] }[] = [];
  for (const w of wantReviews) {
    const k = reviewKey(w.pid, w.email);
    const r = byKey.get(k);
    check(r !== undefined, () => `review ${k} missing`);
    if (!r) continue;
    check(r.rtype === RTYPE[w.role], () => `review ${k}: rtype ${r.rtype}, expected ${RTYPE[w.role]}`);
    check(r.status === w.status, () => `review ${k}: status ${r.status}, expected ${w.status}`);
    if (w.status === "complete") {
      for (const f of scoreFields.filter((x) => w.scores![x] !== undefined)) {
        check(reviewField(r, f) === w.scores![f], () => `review ${k}: ${f}=${String(reviewField(r, f))}, expected ${w.scores![f]}`);
      }
      for (const f of REVIEW_TEXT_FIELDS) {
        const got = reviewField(r, f);
        check(typeof got === "string" && got.trim() === w.text![f], () => `review ${k}: ${f} text differs`);
      }
      check(near(r.modified_at, w.modifiedAt!), () => `review ${k}: modified_at ${iso(r.modified_at)}, expected ${w.modifiedAt!.toISOString()} ±${TOLERANCE_S}s`);
      if (w.versions.length > 1) historyChecks.push({ r, versions: w.versions });
    } else {
      check(r.modified_at === undefined, () => `review ${k}: empty review has modified_at ${iso(r.modified_at)}`);
    }
  }
  // Score changes: the history must hold each earlier submitted version's
  // scores. One /reviewhistory call per review, so at most MAX_HISTORY_CHECKS
  // (spread evenly) to stay well inside the chair token's rate limit.
  const step = Math.max(1, Math.ceil(historyChecks.length / MAX_HISTORY_CHECKS));
  for (const { r, versions } of historyChecks.filter((_, i) => i % step === 0)) {
    const hist = await client.reviewHistory(r.pid, r.rid);
    const older = hist.versions.slice(1).filter((v) => v.status === "complete");
    check(older.length >= versions.length - 1, () => `review ${r.pid}:${r.reviewer_email}: history has ${older.length} earlier complete versions, expected ${versions.length - 1}`);
    // Deltas are newest first and hold only fields that differ from the next-newer version.
    let cur: Record<string, unknown> = Object.fromEntries(scoreFields.map((f) => [f, reviewField(r, f)]));
    const seen: Record<string, unknown>[] = [];
    for (const v of older) {
      cur = { ...cur };
      for (const f of scoreFields) {
        const x = reviewField(v, f);
        if (x !== undefined) cur[f] = x;
      }
      seen.push(cur);
    }
    for (const want of versions.slice(0, -1).reverse()) {
      const match = seen.some((s) => scoreFields.every((f) => s[f] === want.scores[f]));
      check(match, () => `review ${r.pid}:${r.reviewer_email}: history lacks the earlier version ${JSON.stringify(want.scores)}`);
    }
  }

  // Comments.
  const comments = await client.commentsForPids(pids, { t: "all" });
  const wantComments = [...expected.comments.values()].filter((c) => !c.deleted);
  check(comments.length === wantComments.length, () => `comments: got ${comments.length}, expected ${wantComments.length}`);
  const byPid = new Map<number, typeof comments>();
  for (const c of comments) byPid.set(c.pid, [...(byPid.get(c.pid) ?? []), c]);
  for (const w of wantComments) {
    const list = byPid.get(w.pid) ?? [];
    const i = list.findIndex((x) => (x.author_email ?? "").toLowerCase() === w.email && (x.text ?? "").trim() === w.text);
    check(i >= 0, () => `comment ${w.key} (paper ${w.pid}, ${w.email}) missing or text differs`);
    if (i < 0) continue;
    const c = list.splice(i, 1)[0]!;
    check((c.response !== undefined) === w.response, () => `comment ${w.key}: response=${c.response ?? "(none)"}, expected ${w.response}`);
    check(c.visibility === w.visibility, () => `comment ${w.key}: visibility ${c.visibility}, expected ${w.visibility}`);
    check(near(c.modified_at, w.modifiedAt), () => `comment ${w.key}: modified_at ${iso(c.modified_at)}, expected ${w.modifiedAt.toISOString()} ±${TOLERANCE_S}s`);
  }
  return { problems, checks };
}
