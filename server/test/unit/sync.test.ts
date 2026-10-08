import { beforeEach, describe, expect, it } from "vitest";
import { fixedClock } from "../../src/clock.js";
import type { AcRole } from "../../src/config.js";
import { memoryStore, type Store } from "../../src/store/store.js";
import { coverPids, parseTagField, runSync, tierFor, type SyncOptions } from "../../src/sync/sync.js";
import { smallWorld, type FakeHotcrp } from "./fake-source.js";

const T1 = new Date("2030-02-12T12:00:00Z");
const T2 = new Date("2030-02-20T12:00:00Z");
const s = (d: Date) => d.getTime() / 1000;

const TABLES = [
  "person",
  "paper",
  "assignment",
  "review",
  "review_version",
  "review_text",
  "comment",
  "comment_text",
  "comment_mention",
  "review_field",
  "rating_change",
];

function opts(at: Date, extra: Partial<SyncOptions> = {}): SyncOptions {
  return {
    clock: fixedClock(at),
    chunkSize: 2,
    concurrency: 2,
    tierTags: { junior: "junior", reciprocal: "reciprocal" },
    acRole: { kind: "meta" } as AcRole,
    ...extra,
  };
}

function rowCounts(store: Store): Record<string, number> {
  return Object.fromEntries(
    TABLES.map((t) => [t, (store.db.prepare(`select count(*) as n from ${t}`).get() as { n: number }).n]),
  );
}

let hc: FakeHotcrp;
let store: Store;

beforeEach(() => {
  hc = smallWorld();
  store = memoryStore();
});

describe("first sync", () => {
  it("loads papers, people, assignments, reviews, comments", async () => {
    const r = await runSync(store.db, hc, opts(T1));
    expect(r.ok, r.errors.join("; ")).toBe(true);
    expect(r.counts).toMatchObject({ papers_new: 3, reviews_new: 7, comments_new: 3, reviews_fetched: 7 });

    const papers = store.papers();
    expect(papers.map((p) => p.pid)).toEqual([1, 2, 3]);
    expect(papers[0]).toMatchObject({ title: "Paper One", tags: ["accept-maybe"], decision: null, lead: "ben@example.org" });
    expect(papers[1]).toMatchObject({ manager: "ada@example.org" });
    expect(papers[2]).toMatchObject({ decision: "Accepted" });

    const people = Object.fromEntries(store.people().map((p) => [p.email, p]));
    expect(people["ada@example.org"]).toMatchObject({ roles: ["pc", "chair"], tier: "senior", isPc: true });
    expect(people["cy@example.org"]).toMatchObject({ tier: "junior", tags: ["junior"] });
    expect(people["dee@example.org"]).toMatchObject({ tier: "reciprocal", tags: ["reciprocal"] });
    expect(people["eve@example.org"]!.tier).toBe("senior");

    const asg = store.assignments({ pids: [1] }).map((a) => `${a.role}:${a.email}`);
    expect(asg).toEqual(["lead:ben@example.org", "meta:ben@example.org", "primary:cy@example.org", "primary:eve@example.org"]);
    expect(store.assignments({ pids: [2], roles: ["manager"] }).map((a) => a.email)).toEqual(["ada@example.org"]);
  });

  it("uses modified_at (approximate) as first_seen_at for items present at the first sync", async () => {
    await runSync(store.db, hc, opts(T1));
    const rv = Object.fromEntries(store.reviews().map((r) => [r.rid, r]));
    expect(rv[12]).toMatchObject({ firstSeenAt: 1_890_000_012, firstSeenApprox: true, complete: true, firstCompleteSeenAt: 1_890_000_012 });
    // No modified_at -> the sync time, still approximate.
    expect(rv[22]).toMatchObject({ firstSeenAt: s(T1), firstSeenApprox: true, complete: false, firstCompleteSeenAt: null });
    const cm = Object.fromEntries(store.comments().map((c) => [c.cid, c]));
    expect(cm[101]).toMatchObject({ firstSeenAt: 1_890_000_101, firstSeenApprox: true });
    expect(store.assignments()[0]!.firstSeenApprox).toBe(true);
  });

  it("splits scores from text, counts words locally, keeps ratings", async () => {
    await runSync(store.db, hc, opts(T1));
    const r = store.reviews({ pids: [1] }).find((x) => x.rid === 12)!;
    expect(r.scores).toEqual({ OveMer: 2, RevExp: 3 });
    expect(r.wordCount).toBe(3 + 4);
    expect(store.reviewText(12)).toEqual({ PapSum: "Short summary here.", ComAut: "Needs more evaluation work." });
    expect(store.reviews().find((x) => x.rid === 13)!.ratings).toEqual({ short: 1 });
    // First sight of a rated review: before = null.
    expect(store.ratingChanges()).toEqual([{ rid: 13, seenAt: s(T1), before: null, after: { short: 1 } }]);
    expect(store.ratingSettings()).toEqual({ setting: "pc", visibility: "limited", enabled: true });
    // Null scores are kept as null; empty text is not stored.
    expect(store.reviews().find((x) => x.rid === 22)!.scores).toEqual({ OveMer: null, RevExp: null });
    expect(store.reviewText(22)).toEqual({});
  });

  it("ignores checkbox fields and stores a score's false (no entry) as null", async () => {
    hc.form = {
      ...hc.form,
      reviewform: {
        ...hc.form.reviewform,
        IFolIns: { uid: "IFolIns", name: "I followed the instructions", type: "checkbox", order: 5 },
        Topics: { uid: "Topics", name: "Topics", type: "checkboxes", order: 6, values: ["Systems", "Theory"] },
      },
    };
    const r12 = hc.reviewList.find((x) => x.rid === 12)!;
    Object.assign(r12, { OveMer: false, IFolIns: true, Topics: ["A", "B"] });
    Object.assign(hc.reviewList.find((x) => x.rid === 13)!, { IFolIns: false, Topics: [] });
    const res = await runSync(store.db, hc, opts(T1));
    expect(res.ok).toBe(true);
    const reviews = store.reviews({ pids: [1] });
    expect(reviews.find((x) => x.rid === 12)!.scores).toEqual({ OveMer: null, RevExp: 3 });
    expect(reviews.find((x) => x.rid === 13)!.scores).toEqual({ OveMer: 4, RevExp: 4 });
    expect(store.reviewText(12)).toEqual({ PapSum: "Short summary here.", ComAut: "Needs more evaluation work." });
  });

  it("parses mentions against the roster", async () => {
    await runSync(store.db, hc, opts(T1));
    const cm = Object.fromEntries(store.comments().map((c) => [c.cid, c]));
    expect(cm[101]!.mentions).toEqual(["cy@example.org"]);
    expect(cm[102]!.mentions).toEqual([]);
    expect(cm[201]!.mentions).toEqual(["dee@example.org", "eve@example.org"]);
    expect(cm[101]!.wordCount).toBe(9);
    const m = store.db.prepare("select email from comment_mention where cid = 201 order by email").all();
    expect(m).toEqual([{ email: "dee@example.org" }, { email: "eve@example.org" }]);
  });

  it("indexes review and comment text for full-text search", async () => {
    await runSync(store.db, hc, opts(T1));
    const hits = store.searchText("baselines");
    expect(hits).toEqual([expect.objectContaining({ kind: "comment", cid: 102, pid: 1 })]);
    expect(hits[0]!.snippet).toContain("baselines");
    const rh = store.searchText("evaluation");
    expect(rh.map((h) => h.kind).sort()).toEqual(["comment", "review"]);
    expect(rh.find((h) => h.kind === "review")).toMatchObject({ rid: 12, fieldUid: "ComAut" });
  });

  it("asks HotCRP for tag holders on covering papers only, only for tags that exist", async () => {
    await runSync(store.db, hc, opts(T1, { tierTags: { junior: "junior", gone: "nosuchtag" } }));
    // Papers 1 and 2 cover every reviewer (one chunk of 2); one tag exists.
    expect(hc.calls.filter((c) => c === "reviews-rq")).toHaveLength(1);
    // 3 papers / chunk 2 = 2 chunks.
    expect(hc.calls.filter((c) => c === "reviews")).toHaveLength(2);
    expect(hc.calls.filter((c) => c === "comments")).toHaveLength(2);
  });

  it("finds a tagged reviewer the covering papers miss (external, not in get/pcassignments)", async () => {
    hc.people.push({ name: "Xi Outside", email: "xi@example.org", tags: ["junior"], external: true });
    hc.papersList.push({ pid: 4, title: "Paper Four" });
    hc.review({ pid: 4, rid: 41, rtype: 1, reviewer_email: "xi@example.org", OveMer: 3, RevExp: 2, PapSum: "Ok.", ComAut: "Fine." });
    const first = await runSync(store.db, hc, opts(T1));
    expect(first.ok, first.errors.join("; ")).toBe(true);
    expect(store.people().find((p) => p.email === "xi@example.org")).toMatchObject({ isPc: false, tier: "junior", tags: ["junior"] });
    expect(store.people().find((p) => p.email === "cy@example.org")).toMatchObject({ tier: "junior" });
    // Next time xi is a known reviewer, so paper 4 is in the cover: no extra queries, no changes.
    hc.calls = [];
    const again = await runSync(store.db, hc, opts(T2));
    const { reviews_fetched: _r, comments_fetched: _c, tag_queries, ...rest } = again.counts;
    expect(rest).toEqual({});
    expect(tag_queries).toBe(2);
    expect(store.people().find((p) => p.email === "xi@example.org")).toMatchObject({ tier: "junior" });
  });

  it("records the run", async () => {
    const r = await runSync(store.db, hc, opts(T1));
    const run = store.lastSync()!;
    expect(run).toMatchObject({ id: r.runId, ok: true, nowUsed: s(T1), kind: "sync" });
    expect(run.counts.reviews_new).toBe(7);
    expect(store.lastSuccessfulSync()!.id).toBe(r.runId);
  });
});

describe("idempotence", () => {
  it("a second sync with no changes writes zero new rows and changes nothing", async () => {
    await runSync(store.db, hc, opts(T1));
    const before = rowCounts(store);
    const snapshot = JSON.stringify([store.reviewsWithHistory(), store.comments(), store.people(), store.assignments(), store.papers()]);
    const r = await runSync(store.db, hc, opts(T2));
    expect(r.ok).toBe(true);
    expect(rowCounts(store)).toEqual(before);
    const { reviews_fetched, comments_fetched, tag_queries, ...rest } = r.counts;
    expect(rest).toEqual({});
    expect([reviews_fetched, comments_fetched, tag_queries]).toEqual([7, 3, 2]);
    expect(JSON.stringify([store.reviewsWithHistory(), store.comments(), store.people(), store.assignments(), store.papers()])).toBe(snapshot);
  });
});

describe("second sync diffs", () => {
  beforeEach(async () => {
    await runSync(store.db, hc, opts(T1));
  });

  it("score change -> one new review_version seen at t2; text versioned by vtag", async () => {
    const r = hc.reviewList.find((x) => x.rid === 12)!;
    Object.assign(r, { OveMer: 3, version: 17, modified_at: s(T2) - 60 }); // a smaller vtag is still a change
    const res = await runSync(store.db, hc, opts(T2));
    expect(res.counts).toMatchObject({ review_versions_new: 1, reviews_changed: 1, review_texts_new: 2 });
    const h = store.reviewsWithHistory({ pids: [1] }).find((x) => x.rid === 12)!;
    expect(h.scores.OveMer).toBe(3);
    expect(h.versions.map((v) => [v.vtag, v.scores.OveMer, v.seenAt, v.source])).toEqual([
      [1012, 2, s(T1), "snapshot"],
      [17, 3, s(T2), "snapshot"],
    ]);
    expect(h.firstSeenAt).toBe(1_890_000_012); // unchanged
  });

  it("same vtag, different fields -> no new version (vtags decide versions)", async () => {
    Object.assign(hc.reviewList.find((x) => x.rid === 12)!, { ratings: ["short", "vague"] });
    const res = await runSync(store.db, hc, opts(T2));
    expect(res.counts.review_versions_new).toBeUndefined();
    expect(store.reviews().find((x) => x.rid === 12)!.ratings).toEqual({ short: 1, vague: 1 });
  });

  it("ratings change with no vtag change: each sync diffs them into rating_change, once", async () => {
    const r12 = hc.reviewList.find((x) => x.rid === 12)!;
    const r13 = hc.reviewList.find((x) => x.rid === 13)!;
    Object.assign(r12, { ratings: ["short", "short", "vague"] }); // a multiset: two raters said short
    delete r13.ratings; // the rating was withdrawn
    const res = await runSync(store.db, hc, opts(T2));
    expect(res.counts.rating_changes).toBe(2);
    expect(res.counts.review_versions_new).toBeUndefined();
    expect(store.ratingChanges({ rids: [12, 13] })).toEqual([
      { rid: 13, seenAt: s(T1), before: null, after: { short: 1 } },
      { rid: 12, seenAt: s(T2), before: {}, after: { short: 2, vague: 1 } },
      { rid: 13, seenAt: s(T2), before: { short: 1 }, after: {} },
    ]);
    // Idempotent: the same ratings again change nothing.
    const again = await runSync(store.db, hc, opts(new Date(T2.getTime() + 3_600_000)));
    expect(again.counts.rating_changes).toBeUndefined();
    expect(store.ratingChanges()).toHaveLength(3);
  });

  it("stores the rating settings; ratings off is remembered", async () => {
    hc.ratingConfig = { review_rating: "no", review_rating_visibility: "no" };
    await runSync(store.db, hc, opts(T2));
    expect(store.ratingSettings()).toEqual({ setting: "no", visibility: "no", enabled: false });
  });

  it("new comment -> first_seen_at = t2, not approximate", async () => {
    hc.comment({ pid: 2, cid: 202, author_email: "dee@example.org", text: "I lean reject, @Ben Area.", modified_at: s(T2) - 3600 });
    const res = await runSync(store.db, hc, opts(T2));
    expect(res.counts).toMatchObject({ comments_new: 1, comment_texts_new: 1, mentions: 1 });
    expect(store.comments({ pids: [2] }).find((c) => c.cid === 202)).toMatchObject({
      firstSeenAt: s(T2),
      firstSeenApprox: false,
      mentions: ["ben@example.org"],
    });
  });

  it("edited comment -> new comment_text row, mentions re-parsed, first_seen_at kept", async () => {
    Object.assign(hc.commentList.find((c) => c.cid === 102)!, { text: "Sure. @Ben Area the baselines are weak.", modified_at: s(T2) - 10 });
    const res = await runSync(store.db, hc, opts(T2));
    expect(res.counts).toMatchObject({ comment_texts_new: 1, comments_changed: 1 });
    const c = store.comments().find((x) => x.cid === 102)!;
    expect(c).toMatchObject({ firstSeenAt: 1_890_000_102, mentions: ["ben@example.org"], modifiedAt: s(T2) - 10 });
    expect(store.commentHistory(102).map((v) => [v.seenAt, v.text])).toEqual([
      [s(T1), "Sure, the baselines are weak."],
      [s(T2), "Sure. @Ben Area the baselines are weak."],
    ]);
    expect(store.commentText(102)).toBe("Sure. @Ben Area the baselines are weak.");
  });

  it("deleted comment -> deleted_seen_at = t2, row kept; reappearing restores it", async () => {
    hc.commentList = hc.commentList.filter((c) => c.cid !== 101);
    const res = await runSync(store.db, hc, opts(T2));
    expect(res.counts.comments_deleted).toBe(1);
    expect(store.comments().map((c) => c.cid)).not.toContain(101);
    expect(store.comments({ includeGone: true }).find((c) => c.cid === 101)!.deletedSeenAt).toBe(s(T2));
    hc.comment({ pid: 1, cid: 101, author_email: "ben@example.org", text: "@Cy Junior can you say more about the evaluation?", modified_at: 1_890_000_101 });
    const again = await runSync(store.db, hc, opts(new Date(T2.getTime() + 1000)));
    expect(again.counts.comments_restored).toBe(1);
    expect(store.comments().find((c) => c.cid === 101)!.deletedSeenAt).toBeNull();
  });

  it("unassigned review -> review deleted_seen_at and assignment removed_seen_at = t2", async () => {
    hc.reviewList = hc.reviewList.filter((r) => r.rid !== 22);
    hc.assignmentRows = hc.assignmentRows.filter((a) => !(a.paper === 2 && a.email === "dee@example.org"));
    const res = await runSync(store.db, hc, opts(T2));
    expect(res.counts).toMatchObject({ reviews_deleted: 1, assignments_removed: 1 });
    expect(store.reviews({ includeGone: true }).find((r) => r.rid === 22)!.deletedSeenAt).toBe(s(T2));
    expect(store.reviews().map((r) => r.rid)).not.toContain(22);
    const a = store.assignments({ pids: [2], includeGone: true }).find((x) => x.email === "dee@example.org")!;
    expect(a).toMatchObject({ role: "primary", removedSeenAt: s(T2) });
  });

  it("a review completing between syncs gets first_complete_seen_at = t2", async () => {
    Object.assign(hc.reviewList.find((x) => x.rid === 22)!, {
      status: "complete", version: 9022, OveMer: 1, RevExp: 2, PapSum: "Late.", ComAut: "Reject.", modified_at: s(T2) - 5,
    });
    await runSync(store.db, hc, opts(T2));
    expect(store.reviews().find((r) => r.rid === 22)).toMatchObject({
      complete: true, firstCompleteSeenAt: s(T2), firstCompleteApprox: false, firstSeenAt: s(T1),
    });
  });

  it("new review, paper, PC member, and departures", async () => {
    hc.papersList.push({ pid: 4, title: "Paper Four" });
    hc.people.push({ name: "Fay New", email: "fay@example.org", tags: ["junior"] });
    hc.people = hc.people.filter((p) => p.email !== "ada@example.org");
    hc.review({ pid: 4, rid: 41, reviewer_email: "fay@example.org", status: "empty" });
    hc.papersList = hc.papersList.filter((p) => p.pid !== 3);
    hc.reviewList = hc.reviewList.filter((r) => r.pid !== 3);
    const res = await runSync(store.db, hc, opts(T2));
    expect(res.counts).toMatchObject({ papers_new: 1, papers_deleted: 1, people_new: 1, people_removed: 1, reviews_new: 1, reviews_deleted: 1 });
    expect(store.reviews().find((r) => r.rid === 41)).toMatchObject({ firstSeenAt: s(T2), firstSeenApprox: false });
    expect(store.people().find((p) => p.email === "fay@example.org")!.tier).toBe("junior");
    expect(store.people({ includeGone: true }).find((p) => p.email === "ada@example.org")!.removedSeenAt).toBe(s(T2));
    expect(store.papers({ includeGone: true }).find((p) => p.pid === 3)!.deletedSeenAt).toBe(s(T2));
  });
});

describe("failures", () => {
  it("a failed fetch rolls the whole run back and records the error", async () => {
    await runSync(store.db, hc, opts(T1));
    const before = rowCounts(store);
    hc.comment({ pid: 1, cid: 103, author_email: "eve@example.org", text: "new", modified_at: s(T2) });
    Object.assign(hc.reviewList.find((x) => x.rid === 12)!, { OveMer: 5, version: 99 });
    hc.calls = [];
    hc.failOn = { comments: 2 };
    const r = await runSync(store.db, hc, opts(T2));
    expect(r.ok).toBe(false);
    expect(r.errors.at(-1)).toMatch(/injected failure/);
    expect(rowCounts(store)).toEqual(before);
    expect(store.lastSync()).toMatchObject({ ok: false, id: r.runId });
    expect(store.lastSuccessfulSync()!.id).toBeLessThan(r.runId);
  });

  it("a failed first sync leaves the next one as the 'first' (approximate times)", async () => {
    hc.failOn = { reviews: 1 };
    expect((await runSync(store.db, hc, opts(T1))).ok).toBe(false);
    hc.failOn = {};
    expect((await runSync(store.db, hc, opts(T2))).ok).toBe(true);
    expect(store.reviews().find((r) => r.rid === 12)).toMatchObject({ firstSeenAt: 1_890_000_012, firstSeenApprox: true });
  });

  it("an ambiguous manager name is left unset with a warning", async () => {
    hc.people.push({ name: "Ada Chair", email: "ada2@example.org" });
    const r = await runSync(store.db, hc, opts(T1));
    expect(r.ok).toBe(true);
    expect(r.errors[0]).toMatch(/manager name matched zero or several/);
    expect(store.papers().find((p) => p.pid === 2)!.manager).toBeNull();
  });
});

describe("area chairs", () => {
  it("meta: rtype-5 reviewers", async () => {
    await runSync(store.db, hc, opts(T1));
    expect(store.areaChairs({ kind: "meta" })).toEqual([
      { pid: 1, email: "ben@example.org" },
      { pid: 2, email: "ben@example.org" },
    ]);
  });

  it("lead and manager from /search + get/lead", async () => {
    await runSync(store.db, hc, opts(T1));
    expect(store.areaChairs({ kind: "lead" })).toEqual([{ pid: 1, email: "ben@example.org" }]);
    expect(store.areaChairs({ kind: "manager" }, { pids: [2] })).toEqual([{ pid: 2, email: "ada@example.org" }]);
  });

  it("tag:<t>: assigned reviewers who hold the user tag", async () => {
    hc.people.find((p) => p.email === "eve@example.org")!.tags = ["ac"];
    await runSync(store.db, hc, opts(T1, { acRole: { kind: "tag", tag: "ac" } }));
    expect(store.areaChairs({ kind: "tag", tag: "ac" })).toEqual([
      { pid: 1, email: "eve@example.org" },
      { pid: 2, email: "eve@example.org" },
      { pid: 3, email: "eve@example.org" },
    ]);
    expect(store.people().find((p) => p.email === "eve@example.org")).toMatchObject({ tags: ["ac"], tier: "senior" });
  });
});

describe("helpers", () => {
  it("parseTagField", () => {
    expect(parseTagField("#b #a#2")).toEqual(["a#2", "b"]);
    expect(parseTagField(undefined)).toEqual([]);
  });
  it("tierFor: first configured tier wins; untagged = senior", () => {
    const tiers = { junior: "junior", reciprocal: "recip" };
    expect(tierFor(["recip", "junior"], tiers)).toBe("junior");
    expect(tierFor(["RECIP"], tiers)).toBe("reciprocal");
    expect(tierFor([], tiers)).toBe("senior");
  });
});

describe("coverPids", () => {
  it("picks few papers that together hold a review by every reviewer", () => {
    const pairs = [
      { pid: 1, email: "a" }, { pid: 1, email: "b" },
      { pid: 2, email: "b" }, { pid: 2, email: "c" }, { pid: 2, email: "d" },
      { pid: 3, email: "a" }, { pid: 3, email: "e" },
      { pid: 4, email: "d" },
    ];
    const cover = coverPids(pairs);
    expect(cover).toEqual([2, 3]);
    const covered = new Set(pairs.filter((p) => cover.includes(p.pid)).map((p) => p.email));
    expect([...covered].sort()).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("is empty for no reviewers", () => {
    expect(coverPids([])).toEqual([]);
  });
});
