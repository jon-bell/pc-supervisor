// Regression (chair feedback): the AC table's "Comments" read 0 on a real
// shadow PC although the paper drawer listed the AC's comments.
//
// Cause: the column counted only comments at or after PCS_PHASE_DISCUSSION_OPEN.
// HotCRP lets the PC discuss as soon as reviews are visible, so on a live PC
// most AC comments predate the configured discussion date (and before that
// date every AC read 0). The comment JSON itself matched the harness: for a
// chair token HotCRP sends `author_email` (src/commentinfo.php), in the case
// it was stored, and the sync lowercases it like reviewer_email.
//
// The fake world below uses that real-instance shape: mixed-case stored
// emails on /pc, assignments, reviews and comments, `author` as HTML plus
// `author_email`, `ordinal`, `editable`, and comments posted while reviewing.
// Synthetic data only (example.org).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixedClock } from "../../src/clock.js";
import { loadConfig, type Config } from "../../src/config.js";
import type { Comment } from "../../src/hotcrp/schemas.js";
import type { AcsResponse, PersonResponse } from "../../src/server/api-types.js";
import { buildApp, type App } from "../../src/server/app.js";
import { memoryStore, type Store } from "../../src/store/store.js";
import { runSync } from "../../src/sync/sync.js";
import { RULES_ENV } from "../fixtures/builder.js";
import { FakeHotcrp } from "./fake-source.js";

// ci.yml-style phases (RULES_ENV): discussion opens 2030-02-12T00:00 New York.
const sec = (iso: string) => Date.parse(iso) / 1000;
const AC = "Mira.Okafor@Example.ORG";
const ac = AC.toLowerCase();

function realShapeWorld(o: { discussionStarted: boolean }): FakeHotcrp {
  const f = new FakeHotcrp();
  f.people = [
    { name: "Ada Chair", email: "ada@example.org", chair: true },
    { name: "Mira Okafor", email: AC },
    { name: "Tomas Reyes", email: "Tomas.Reyes@example.org" },
    { name: "Lin Wu", email: "lin.wu@example.org" },
  ];
  f.papersList = [
    { pid: 1, title: "Synthetic Paper One" },
    { pid: 2, title: "Synthetic Paper Two" },
  ];
  f.assignmentRows = [
    { paper: 1, action: "metareview", email: AC },
    { paper: 1, action: "primaryreview", email: "Tomas.Reyes@example.org" },
    { paper: 2, action: "metareview", email: AC },
    { paper: 2, action: "primaryreview", email: "lin.wu@example.org" },
  ];
  const reviewed = sec("2030-01-25T15:00:00Z");
  f.review({ pid: 1, rid: 11, rtype: 5, reviewer_email: AC, status: "empty", version: 5011 });
  f.review({ pid: 1, rid: 12, reviewer_email: "Tomas.Reyes@example.org", OveMer: 2, RevExp: 3, PapSum: "Summary.", ComAut: "Comments.", modified_at: reviewed });
  f.review({ pid: 2, rid: 21, rtype: 5, reviewer_email: AC, status: "empty", version: 5021 });
  f.review({ pid: 2, rid: 22, reviewer_email: "lin.wu@example.org", OveMer: 4, RevExp: 3, PapSum: "Summary.", ComAut: "Comments.", modified_at: reviewed });
  type C = Partial<Comment> & { pid: number; cid: number; author_email: string; text: string };
  const real = (c: C) => f.comment({ ordinal: String(c.cid), author: `<span class="taghl">${c.author_email.split("@")[0]}</span>`, editable: true, format: 0, ...c });
  // Two AC comments while reviewing (before discussion opens), one after.
  real({ pid: 1, cid: 101, author_email: AC, text: "Early question on the evaluation.", modified_at: sec("2030-01-28T14:00:00Z") });
  real({ pid: 2, cid: 201, author_email: AC, text: "Early thoughts on related work.", modified_at: sec("2030-02-02T14:00:00Z") });
  if (o.discussionStarted) real({ pid: 2, cid: 202, author_email: AC, text: "Discussion is open, please weigh in.", modified_at: sec("2030-02-13T14:00:00Z") });
  real({ pid: 1, cid: 102, author_email: "Tomas.Reyes@example.org", text: "A reply.", modified_at: sec("2030-01-29T14:00:00Z") });
  return f;
}

/** Sync at `now` (what HotCRP holds then), and serve with PCS_NOW = now. */
async function appAt(now: string): Promise<{ api: App; store: Store; cfg: Config }> {
  const cfg = loadConfig({ ...RULES_ENV, PCS_NOW: now });
  const store = memoryStore();
  const r = await runSync(store.db, realShapeWorld({ discussionStarted: cfg.now! >= cfg.phases.discussionOpen }), {
    clock: fixedClock(cfg.now!),
    chunkSize: 200,
    concurrency: 2,
    tierTags: cfg.tierTags,
    acRole: cfg.acRole,
  });
  expect(r.ok, r.errors.join("; ")).toBe(true);
  return { api: await buildApp({ cfg, store, clock: fixedClock(cfg.now!), webDir: null }), store, cfg };
}

const json = async <T>(api: App, url: string): Promise<T> => {
  const r = await api.app.inject({ method: "GET", url });
  expect(r.statusCode, `${url}: ${r.body}`).toBe(200);
  return r.json() as T;
};

describe("AC comment counts over real-instance data", () => {
  let a: Awaited<ReturnType<typeof appAt>>;
  beforeAll(async () => (a = await appAt("2030-02-20T12:00")));
  afterAll(async () => {
    await a.api.app.close();
    a.store.close();
  });

  it("counts every AC comment the drawer shows, not only those since discussion opened", async () => {
    const acs = await json<AcsResponse>(a.api, "/api/acs");
    expect(acs.acs.map((x) => x.person.email)).toEqual([ac]);
    // Before the fix: comments did not exist and discussionComments was the
    // only count, 1 here; on the chair's PC (no comment after the date) it was 0.
    expect(acs.acs[0]).toMatchObject({ comments: 3, discussionComments: 1, coverage: { covered: 1, of: 2 } });

    // The drawer agrees: the same comments, attributed to the AC.
    let drawerAc = 0;
    for (const pid of [1, 2]) {
      const d = await json<{ comments: { role: string; author: { email: string } }[] }>(a.api, `/api/papers/${pid}`);
      drawerAc += d.comments.filter((c) => c.role === "AC" && c.author.email === ac).length;
    }
    expect(drawerAc).toBe(acs.acs[0]!.comments);
  });

  it("the person page's AC summary carries the same counts", async () => {
    const p = await json<PersonResponse>(a.api, `/api/people/${encodeURIComponent(AC)}`);
    expect(p.ac).toMatchObject({ comments: 3, discussionComments: 1 });
    expect(p.papers.map((x) => [x.pid, x.comments, x.discussionComments])).toEqual([
      [1, 1, 0],
      [2, 2, 1],
    ]);
  });
});

describe("before discussion opens (the chair's live PC, real clock)", () => {
  let a: Awaited<ReturnType<typeof appAt>>;
  beforeAll(async () => (a = await appAt("2030-02-05T12:00")));
  afterAll(async () => {
    await a.api.app.close();
    a.store.close();
  });

  it("shows the comments posted so far instead of 0", async () => {
    const acs = await json<AcsResponse>(a.api, "/api/acs");
    // Cids 101 and 201, both posted while reviewing.
    expect(acs.acs[0]).toMatchObject({ comments: 2, discussionComments: 0, coverage: { share: null } });
  });
});
