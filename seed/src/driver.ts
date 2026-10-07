// The seeding driver (spec §9.3). For each scenario stage:
//
//   1. structure via batch scripts (stage 1 only): settings, users, papers
//      (with a PDF, so they count as submitted), assignments;
//   2. activity via the API: POST /reviews (notify=0) and POST /comments
//      (actas=<author>, notify=0), decisions and unassignments via
//      batch/assign.php;
//   3. a SQL time-warp that moves every object's timestamps to its intended
//      (phase-relative) time, preserving HotCRP's invariants.
//
// Events are applied in "waves": wave k holds the k-th event of every object
// (a review, a comment, a decision), in time order. Each wave is written and
// then warped before the next starts, so an object's later version (a score
// change, a comment edit) always builds on its already-backdated earlier one.
// That is what makes HotCRP's review history (PaperReviewHistory) carry the
// earlier version with its earlier time.
//
// The driver expects a fresh harness. It records its progress in a Settings
// row (`__pcs_seed`), refuses to seed stage 1 over existing papers unless
// --force (or --reset, which empties the harness first), and refuses stage
// N > 1 unless stage N-1 of the same scenario is the last one seeded.

import { assertHarnessUrl } from "@pcs/server/hotcrp/harness-guard";
import { loadPhaseConfig } from "@pcs/server/config";
import { checkHarnessMatchesUrl, dockerOptionsFromEnv, Harness, sqlInt, sqlString } from "./docker.js";
import { PAPER_SUBMITTED_AT, type Scenario, type ScenarioEvent } from "./format.js";
import { mentionName, planWaves, replay, reviewKey, timedEvents, type ExpectedState, type TimedEvent } from "./model.js";
import { abstractText, commentText, reviewText } from "./text.js";
import { epochSeconds, resolveWhen, type PhaseContext } from "./time.js";
import { SeedWriter, type CommentPost, type ReviewPost } from "./writer.js";

type Env = Readonly<Record<string, string | undefined>>;

export const SEEDER_EMAIL = "seeder@example.org";
const MARKER = "__pcs_seed";
const REVIEW_BATCH = 100;
const COMMENT_BATCH = 100;
const API_CONCURRENCY = 4;
// Comments go one request at a time: HotCRP's comment save (insert, then
// ordinal assignment) races under concurrent POST /comments and intermittently
// answers "Error saving comment" (seen in e2e seeding).
const COMMENT_CONCURRENCY = 1;

/** HotCRP settings every scenario needs (batch/settings.php JSON). */
export const HARNESS_SETTINGS = {
  // POST /reviews ignores `override` for JSON bodies, so open review deadlines.
  review_open: true,
  review: [{ id: 1, name: "", soft: "2099-01-01", done: "2099-01-02" }],
  comment_allow_always: true,
  // One unnamed response round (round name "1"), open on HotCRP's wall clock.
  response_active: true,
  response: [{ id: 1, name: "", open: "2020-01-01", done: "2099-01-01", wordlimit: 0 }],
};

/**
 * HARNESS_SETTINGS plus the scenario's phase-2 structure: named review rounds
 * (e.g. quickreject) and submission options (`sf`). Both are matched by name,
 * so seeding again (after a reset, which keeps Settings) changes nothing.
 * Rounds and options from an earlier scenario stay defined; they are empty.
 */
export function scenarioSettings(scenario: Scenario): Record<string, unknown> {
  const rounds = (scenario.reviewRounds ?? []).map((name) => ({ name, soft: "2099-01-01", done: "2099-01-02" }));
  const sf = (scenario.submissionFields ?? []).map((f) => ({
    name: f.name,
    type: f.type,
    visibility: f.visibility ?? "admin",
    ...(f.values ? { values: f.values.map((name) => ({ name })) } : {}),
  }));
  return {
    ...HARNESS_SETTINGS,
    review: [...HARNESS_SETTINGS.review, ...rounds],
    ...(sf.length > 0 ? { sf } : {}),
  };
}

export interface SeedOptions {
  /** Seed only this stage (1-based). Default: every stage, in order. */
  stage?: number;
  /** Seed even if the harness already has papers. */
  force?: boolean;
  /** Empty the harness first (resetHarness). */
  reset?: boolean;
  env?: Env;
  log?: (line: string) => void;
}

export interface SeedContext {
  harness: Harness;
  ctx: PhaseContext;
  url: string;
  log: (line: string) => void;
}

export function seedContextFromEnv(env: Env = process.env, log: (l: string) => void = () => {}): SeedContext {
  const url = assertHarnessUrl(env);
  const ctx = loadPhaseConfig(env);
  return { harness: new Harness(dockerOptionsFromEnv(env)), ctx, url, log };
}

interface Marker {
  scenario: string;
  stage: number;
}

async function readMarker(h: Harness): Promise<Marker | undefined> {
  const rows = await h.sql(`select value, data from Settings where name=${sqlString(MARKER)};`);
  const r = rows[0];
  return r ? { stage: Number(r[0]), scenario: r[1] ?? "" } : undefined;
}

async function writeMarker(h: Harness, m: Marker): Promise<void> {
  await h.sql(
    `insert into Settings (name, value, data) values (${sqlString(MARKER)}, ${sqlInt(m.stage)}, ${sqlString(m.scenario)})` +
      ` on duplicate key update value=values(value), data=values(data);`,
  );
}

/** Which scenario/stage the harness was last seeded with, if any. */
export async function seededState(sc: SeedContext): Promise<Marker | undefined> {
  return readMarker(sc.harness);
}

// Tables holding conference content. Settings, accounts with sysadmin, their
// API tokens (Capability), and rate-limit counters survive a reset.
const CONTENT_TABLES = [
  "ActionLog", "ContactPrimary", "DeletedContactInfo", "DocumentLink", "FilteredDocument", "Formula",
  "IDReservation", "Invitation", "InvitationLog", "MailLog", "Paper", "PaperComment", "PaperConflict",
  "PaperOption", "PaperReview", "PaperReviewHistory", "PaperReviewPreference", "PaperReviewRefused",
  "PaperStorage", "PaperTag", "PaperTagAnno", "PaperTopic", "PaperWatch", "ReviewRating", "ReviewRequest",
  "TopicArea", "TopicInterest", "WorkItem",
];

/**
 * Empty the harness: delete all papers, reviews, comments, and every account
 * except sysadmins (the chair whose token is in .env.test, and the seeder).
 * Much faster than `docker compose down -v` + hotcrp-up.sh, and keeps the
 * chair's token valid. Harness only.
 */
export async function resetHarness(sc: SeedContext): Promise<void> {
  await checkHarnessMatchesUrl(sc.harness, sc.url);
  await sc.harness.sql(
    [
      "set foreign_key_checks=0;",
      ...CONTENT_TABLES.map((t) => `truncate table ${t};`),
      "delete from Capability where contactId not in (select contactId from ContactInfo where (roles & 2) != 0);",
      "delete from ContactCounter where contactId not in (select contactId from ContactInfo where (roles & 2) != 0);",
      "delete from ContactInfo where (roles & 2) = 0;",
      "update ContactInfo set contactTags=null;",
      // HotCRP's install inserts paperStorageId 1 as the "empty document"
      // (DocumentInfo::make_empty, src/schema.sql). Without it the first PDF
      // stored after the truncate gets id 1, and that paper silently stays a
      // draft ("Submission: Entry required").
      "insert ignore into PaperStorage set paperStorageId=1, paperId=0, timestamp=0, mimetype='text/plain', paper='', " +
        "sha1=x'da39a3ee5e6b4b0d3255bfef95601890afd80709', documentType=0, size=0, inactive=1;",
      `delete from Settings where name in (${sqlString(MARKER)}, 'pcrev_assigntime', 'metareviews', 'paperacc', 'paperlead', 'papermanager', 'tracker');`,
      "set foreign_key_checks=1;",
    ].join("\n"),
  );
  sc.log("reset: harness emptied (sysadmin accounts and tokens kept)");
}

/**
 * The seeder's own sysadmin account and API token, with raised per-user rate
 * limits (ContactCounter.apiRefreshAmount*). Seeding never spends the chair
 * token's budget, so a timed sync right after `seed scale` isn't throttled.
 */
async function seederToken(h: Harness): Promise<string> {
  await h.batch("saveusers.php", ["-u", SEEDER_EMAIL, "-r", "sysadmin", "--uname", "Seed Bot"]);
  const out = await h.batch("apitoken.php", ["create", "-e", "1d", "--note", "pcs-seed", SEEDER_EMAIL]);
  const token = out.trim().split("\n").pop()?.trim() ?? "";
  if (!/^hct_[A-Za-z0-9]+$/.test(token)) throw new Error("seed: could not mint the seeder's API token");
  await h.sql(
    "insert into ContactCounter (contactId, apiRefreshAmount, apiRefreshAmount2)" +
      ` select contactId, 100000000, 10000000 from ContactInfo where email=${sqlString(SEEDER_EMAIL)}` +
      " on duplicate key update apiRefreshAmount=100000000, apiRefreshAmount2=10000000;",
  );
  return token;
}

/** Seed `scenario` (all stages, or one with opts.stage). Returns the expected state after the last seeded stage. */
export async function seedScenario(scenario: Scenario, opts: SeedOptions = {}): Promise<ExpectedState> {
  const env = opts.env ?? process.env;
  const log = opts.log ?? (() => {});
  const sc = seedContextFromEnv(env, log);
  // Validate the whole scenario (all stages) before touching anything.
  replay(scenario, sc.ctx);
  // Make sure the batch scripts and SQL hit the same instance as the API.
  await checkHarnessMatchesUrl(sc.harness, sc.url);

  const stages = opts.stage !== undefined ? [opts.stage] : scenario.stages.map((_, i) => i + 1);
  if (opts.stage !== undefined && (opts.stage < 1 || opts.stage > scenario.stages.length)) {
    throw new Error(`seed: scenario ${scenario.name} has stages 1..${scenario.stages.length}`);
  }
  if (opts.reset) await resetHarness(sc);

  const h = sc.harness;
  const first = stages[0]!;
  const marker = await readMarker(h);
  if (first === 1) {
    const papers = Number((await h.sql("select count(*) from Paper;"))[0]?.[0] ?? 0);
    if ((papers > 0 || marker) && !opts.force) {
      throw new Error(
        `seed: the harness is not empty (${papers} papers${marker ? `; seeded with ${marker.scenario} stage ${marker.stage}` : ""}). ` +
          "Use --reset to empty it first, or --force to seed on top.",
      );
    }
  } else if (!marker || marker.scenario !== scenario.name || marker.stage !== first - 1) {
    throw new Error(
      `seed: stage ${first} of ${scenario.name} needs stage ${first - 1} seeded last; the harness has ` +
        (marker ? `${marker.scenario} stage ${marker.stage}` : "no seed marker"),
    );
  }

  const t0 = performance.now();
  const writer = new SeedWriter(sc.url, await seederToken(h));
  const run = new StageRunner(scenario, sc, writer);
  if (first === 1) await run.structure();
  else await run.loadIds(first - 1);
  for (const s of stages) {
    await run.stage(s);
    await writeMarker(h, { scenario: scenario.name, stage: s });
  }
  log(`seed: ${scenario.name} stage(s) ${stages.join(",")} done in ${((performance.now() - t0) / 1000).toFixed(1)} s (${writer.requests} API requests)`);
  return replay(scenario, sc.ctx, stages[stages.length - 1]!);
}

/** Run `fn` over `items` with at most `n` in flight. */
async function pool<T>(items: readonly T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]!);
  });
  await Promise.all(workers);
}

function chunks<T>(xs: readonly T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

class StageRunner {
  /** review key (pid:email) -> rid */
  readonly rids = new Map<string, number>();
  /** comment key -> cid */
  readonly cids = new Map<string, number>();
  readonly people: Map<string, { first: string; last: string }>;

  constructor(
    readonly scenario: Scenario,
    readonly sc: SeedContext,
    readonly writer: SeedWriter,
  ) {
    this.people = new Map(scenario.people.map((p) => [p.email.toLowerCase(), p]));
  }

  private get h() {
    return this.sc.harness;
  }

  private t(e: { at: ScenarioEvent["at"] }): number {
    return epochSeconds(resolveWhen(e.at, this.sc.ctx));
  }

  private log(s: string) {
    this.sc.log(s);
  }

  async structure(): Promise<void> {
    const { scenario, h } = this;
    let t = performance.now();
    const lap = (what: string) => {
      const now = performance.now();
      this.log(`  ${what} (${((now - t) / 1000).toFixed(1)} s)`);
      t = now;
    };
    await h.batch("settings.php", ["save", "-e", JSON.stringify(scenarioSettings(scenario))]);
    lap("settings saved");

    // saveusers.php JSON goes through CsvParser::make_json without the CSV
    // synonyms, so keys must be the canonical ones: firstName, lastName, and
    // tags as ONE space-separated string (an array crashes trim()).
    // Non-PC people are saved only when they carry tags (e.g. reserve-pool).
    const users = scenario.people
      .filter((p) => p.roles.length > 0 || (p.tags?.length ?? 0) > 0)
      .map((p) => ({
        email: p.email,
        firstName: p.first,
        lastName: p.last,
        affiliation: p.affiliation ?? "",
        roles: p.roles.join(" "),
        ...(p.tags && p.tags.length > 0 ? { tags: p.tags.join(" ") } : {}),
      }));
    await h.writeFile("/tmp/pcs-seed/users.json", JSON.stringify(users));
    await h.batch("saveusers.php", ["-q", "/tmp/pcs-seed/users.json"]);
    lap(`${users.length} users saved`);

    // Papers need a PDF to count as submitted; content_file is relative to
    // the JSON file's directory.
    await h.sh("mkdir -p /tmp/pcs-seed && cp test/sample50pg.pdf /tmp/pcs-seed/paper.pdf");
    const papers = scenario.papers.map((p) => ({
      pid: p.pid,
      title: p.title,
      abstract: p.abstract ?? abstractText(p.pid),
      authors: p.authors.map((a) => ({ email: a.email, first: a.first, last: a.last, affiliation: a.affiliation ?? "" })),
      status: "submitted",
      submission: { content_file: "paper.pdf", mimetype: "application/pdf" },
      // Submission options go under the option's name (savepapers JSON key).
      ...(p.options ?? {}),
    }));
    await h.writeFile("/tmp/pcs-seed/papers.json", JSON.stringify(papers));
    await h.batch("savepapers.php", ["/tmp/pcs-seed/papers.json"]);
    lap(`${papers.length} papers saved`);

    const withRound = scenario.assignments.some((a) => a.round !== undefined);
    const csv = [
      withRound ? "paper,action,user,round" : "paper,action,user",
      ...scenario.assignments.map((a) => `${a.pid},${a.role},${a.email}${withRound ? `,${a.round ?? ""}` : ""}`),
    ].join("\n");
    await h.writeFile("/tmp/pcs-seed/assign.csv", `${csv}\n`);
    await h.batch("assign.php", ["/tmp/pcs-seed/assign.csv"]);
    lap(`${scenario.assignments.length} assignments made`);

    await this.loadRids();
    // Backdate requests and submissions. timeRequested must stay earliest:
    // HotCRP omits a review's modified_at unless reviewModified > timeRequested.
    const expected = replay(scenario, this.sc.ctx, 1);
    const stmts: string[] = ["start transaction;"];
    for (const r of expected.reviews.values()) {
      const rid = this.rid(r.pid, r.email);
      const tr = epochSeconds(r.requestedAt);
      stmts.push(`update PaperReview set timeRequested=${tr}, timeRequestNotified=if(timeRequestNotified>0,${tr},0) where reviewId=${rid};`);
    }
    const ts = epochSeconds(resolveWhen(PAPER_SUBMITTED_AT, this.sc.ctx));
    stmts.push(`update Paper set timeSubmitted=${ts}, timeModified=${ts} where timeSubmitted>0;`);
    stmts.push(`update PaperStorage set timestamp=${ts};`);
    stmts.push("commit;");
    await h.sql(stmts.join("\n"));
    lap("structure backdated");
  }

  private async loadRids(): Promise<void> {
    const rows = await this.h.sql("select r.paperId, c.email, r.reviewId from PaperReview r join ContactInfo c on c.contactId=r.contactId;");
    this.rids.clear();
    for (const [pid, email, rid] of rows) this.rids.set(reviewKey(Number(pid), email!), Number(rid));
  }

  private rid(pid: number, email: string): number {
    const rid = this.rids.get(reviewKey(pid, email));
    if (rid === undefined) throw new Error(`seed: no review row for ${email} on paper ${pid}`);
    return rid;
  }

  /** Before seeding stage N > 1: find the rids, and the cids of earlier stages' live comments. */
  async loadIds(throughStage: number): Promise<void> {
    await this.loadRids();
    const expected = replay(this.scenario, this.sc.ctx, throughStage);
    const rows = await this.h.sql(
      "select m.commentId, m.paperId, c.email, m.comment from PaperComment m join ContactInfo c on c.contactId=m.contactId;",
    );
    const byText = new Map<string, number>();
    for (const [cid, pid, email, text] of rows) byText.set(`${pid}\t${email!.toLowerCase()}\t${text}`, Number(cid));
    for (const c of expected.comments.values()) {
      if (c.deleted) continue;
      const cid = byText.get(`${c.pid}\t${c.email}\t${c.text}`);
      if (cid === undefined) throw new Error(`seed: can't find stage ${throughStage} comment ${c.key} on paper ${c.pid}; was the harness modified?`);
      this.cids.set(c.key, cid);
    }
  }

  async stage(s: number): Promise<void> {
    const events = timedEvents(this.scenario, this.sc.ctx, s);
    const waves = planWaves(events);
    this.log(`stage ${s}: ${events.length} events in ${waves.length} wave(s)`);
    // Replay up to the previous stage so comment edits know their mentions.
    const state = s > 1 ? replay(this.scenario, this.sc.ctx, s - 1) : undefined;
    const mentionsOf = new Map<string, string[]>();
    for (const c of state?.comments.values() ?? []) mentionsOf.set(c.key, c.mentions);
    const editCount = new Map<string, number>();
    for (const c of state?.comments.values() ?? []) editCount.set(c.key, c.edits);
    const commentAuthor = new Map<string, { pid: number; email: string }>();
    for (const c of state?.comments.values() ?? []) commentAuthor.set(c.key, { pid: c.pid, email: c.email });

    for (const [i, wave] of waves.entries()) {
      const t0 = performance.now();
      await this.wave(wave, mentionsOf, editCount, commentAuthor);
      this.log(`  wave ${i + 1}: ${wave.length} events (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
    }
  }

  private async wave(
    wave: readonly TimedEvent[],
    mentionsOf: Map<string, string[]>,
    editCount: Map<string, number>,
    commentAuthor: Map<string, { pid: number; email: string }>,
  ): Promise<void> {
    const warp: string[] = [];
    const reviews: ReviewPost[] = [];
    const byActor = new Map<string, { item: CommentPost; key?: string; after: (cid: number | undefined) => void }[]>();
    const decisions: string[] = [];
    const unassigns: string[] = [];
    const push = (actor: string, x: { item: CommentPost; key?: string; after: (cid: number | undefined) => void }) => {
      const list = byActor.get(actor) ?? [];
      list.push(x);
      byActor.set(actor, list);
    };

    // Assignments added during a stage go first, so their rids exist; their
    // request time is warped to the event's time (M12).
    const assigns = wave.flatMap(({ event: e }) => (e.type === "assign" ? [e] : []));
    if (assigns.length > 0) {
      await this.h.writeFile("/tmp/pcs-seed/assign-stage.csv", `paper,action,user\n${assigns.map((a) => `${a.pid},${a.role},${a.email}`).join("\n")}\n`);
      await this.h.batch("assign.php", ["/tmp/pcs-seed/assign-stage.csv"]);
      await this.loadRids();
    }

    for (const { event: e } of wave) {
      const t = this.t(e);
      switch (e.type) {
        case "assign": {
          const rid = this.rid(e.pid, e.email);
          warp.push(`update PaperReview set timeRequested=${t}, timeRequestNotified=if(timeRequestNotified>0,${t},0) where reviewId=${rid};`);
          break;
        }
        case "review": {
          const rid = this.rid(e.pid, e.email);
          reviews.push({ pid: e.pid, rid, ...e.scores, ...reviewText(reviewKey(e.pid, e.email), e.words), submitted: true });
          warp.push(
            `update PaperReview set reviewSubmitted=${t}, reviewModified=${t}, timeDisplayed=${t},` +
              ` reviewAuthorModified=if(reviewAuthorModified>0,${t},0) where reviewId=${rid};`,
          );
          break;
        }
        case "scoreChange": {
          const rid = this.rid(e.pid, e.email);
          reviews.push({ pid: e.pid, rid, ...e.scores });
          warp.push(`update PaperReview set reviewModified=${t}, reviewAuthorModified=if(reviewAuthorModified>0,${t},0) where reviewId=${rid};`);
          break;
        }
        case "comment":
        case "response": {
          const mentions = e.type === "comment" ? (e.mentions ?? []).map((m) => m.toLowerCase()) : [];
          const names = mentions.map((m) => mentionName(this.people.get(m)!));
          const words = e.words ?? (e.type === "response" ? 120 : 40);
          const text = commentText(e.key, 0, names, words);
          mentionsOf.set(e.key, mentions);
          editCount.set(e.key, 0);
          commentAuthor.set(e.key, { pid: e.pid, email: e.email.toLowerCase() });
          const item: CommentPost =
            e.type === "response" ? { pid: e.pid, response: "1", text } : { pid: e.pid, text, visibility: e.visibility ?? "rev" };
          push(e.email.toLowerCase(), {
            item,
            key: e.key,
            after: (cid) => {
              if (cid === undefined) throw new Error(`seed: HotCRP returned no cid for comment ${e.key}`);
              this.cids.set(e.key, cid);
              warp.push(`update PaperComment set timeModified=${t}, timeNotified=${t}, timeDisplayed=${t} where commentId=${cid};`);
            },
          });
          break;
        }
        case "commentEdit": {
          const cid = this.cids.get(e.key)!;
          const who = commentAuthor.get(e.key)!;
          const n = (editCount.get(e.key) ?? 0) + 1;
          editCount.set(e.key, n);
          const names = (mentionsOf.get(e.key) ?? []).map((m) => mentionName(this.people.get(m)!));
          push(who.email, {
            item: { pid: who.pid, cid, text: commentText(e.key, n, names, e.words ?? 50) },
            after: () => warp.push(`update PaperComment set timeModified=${t} where commentId=${cid};`),
          });
          break;
        }
        case "commentDelete": {
          const cid = this.cids.get(e.key)!;
          const who = commentAuthor.get(e.key)!;
          push(who.email, { item: { pid: who.pid, cid, delete: true }, after: () => this.cids.delete(e.key) });
          break;
        }
        case "decision":
          decisions.push(`${e.pid},decision,${csvCell(e.decision)}`);
          break;
        case "unassign":
          unassigns.push(`${e.pid},clearreview,${e.email}`);
          break;
      }
    }

    await pool(chunks(reviews, REVIEW_BATCH), API_CONCURRENCY, (batch) => this.writer.reviews(batch));
    const commentJobs = [...byActor.entries()].flatMap(([actor, xs]) => chunks(xs, COMMENT_BATCH).map((c) => [actor, c] as const));
    await pool(commentJobs, COMMENT_CONCURRENCY, async ([actor, xs]) => {
      const cids = await this.writer.comments(
        actor,
        xs.map((x) => x.item),
      );
      xs.forEach((x, i) => x.after(cids[i]));
    });
    if (decisions.length > 0) {
      await this.h.writeFile("/tmp/pcs-seed/decisions.csv", `paper,action,decision\n${decisions.join("\n")}\n`);
      await this.h.batch("assign.php", ["/tmp/pcs-seed/decisions.csv"]);
    }
    if (unassigns.length > 0) {
      await this.h.writeFile("/tmp/pcs-seed/unassign.csv", `paper,action,user\n${unassigns.join("\n")}\n`);
      await this.h.batch("assign.php", ["/tmp/pcs-seed/unassign.csv"]);
    }
    if (warp.length > 0) await this.h.sql(["start transaction;", ...warp, "commit;"].join("\n"));
  }
}

function csvCell(s: string): string {
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
