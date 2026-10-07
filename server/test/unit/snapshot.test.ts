// Store -> rules adapter (views/snapshot.ts) over an in-memory store filled
// by the real sync from a fake HotCRP. Synthetic data only.
import { describe, expect, it } from "vitest";
import { fixedClock } from "../../src/clock.js";
import { evaluateAll } from "../../src/rules/evaluate.js";
import { memoryStore, type Store } from "../../src/store/store.js";
import { runSync } from "../../src/sync/sync.js";
import { buildSnapshot, scoreNumber } from "../../src/views/snapshot.js";
import { contextAt } from "../fixtures/builder.js";
import { FakeHotcrp, smallWorld } from "./fake-source.js";

const T1 = new Date("2030-02-14T12:00:00Z");
const T2 = new Date("2030-02-18T12:00:00Z");
const T3 = new Date("2030-02-19T12:00:00Z");
const s = (d: Date) => d.getTime() / 1000;
const FIELDS = { merit: "OveMer", expertise: "RevExp" };

async function sync(store: Store, hc: FakeHotcrp, at: Date) {
  const r = await runSync(store.db, hc, {
    clock: fixedClock(at),
    chunkSize: 200,
    concurrency: 2,
    tierTags: { junior: "junior", reciprocal: "reciprocal" },
    acRole: { kind: "meta" },
  });
  expect(r.ok, r.errors.join("; ")).toBe(true);
}

async function twoSyncs() {
  const hc = smallWorld();
  const store = memoryStore();
  await sync(store, hc, T1);
  // Between syncs: a score change, an edited comment, a deleted comment, a new comment, a decision.
  const r12 = hc.reviewList.find((r) => r.rid === 12)!;
  Object.assign(r12, { OveMer: 3, version: 9012, modified_at: s(T2) - 3600 });
  const c102 = hc.commentList.find((c) => c.cid === 102)!;
  Object.assign(c102, { text: "Sure, the baselines are weak. @Eve Senior agrees.", modified_at: s(T2) - 1800 });
  hc.commentList = hc.commentList.filter((c) => c.cid !== 201);
  hc.comment({ pid: 2, cid: 202, author_email: "eve@example.org", text: "A late thought, posted as a draft.", draft: true, modified_at: s(T2) - 60 });
  hc.comment({ pid: 2, cid: 203, author_email: "author2@example.org", text: "Response text.", response: "1", modified_at: s(T2) - 120 });
  hc.papersList[0]!.decision = "Rejected";
  await sync(store, hc, T2);
  return { hc, store };
}

describe("buildSnapshot", () => {
  it("maps papers, decisions with their first-seen time, people and tiers, ACs", async () => {
    const { store } = await twoSyncs();
    const v = buildSnapshot(store, { fields: FIELDS, acRole: { kind: "meta" } });
    expect(v.papers).toEqual([
      { pid: 1, title: "Paper One", decision: "Rejected", decisionSeenAt: T2.getTime(), tags: ["accept-maybe"] },
      { pid: 2, title: "Paper Two", decision: null, decisionSeenAt: null, tags: [] },
      // Decided before the first sync: its time is the first sync's (approximate).
      { pid: 3, title: "Paper Three", decision: "Accepted", decisionSeenAt: T1.getTime(), tags: [] },
    ]);
    expect(v.acs).toEqual([
      { pid: 1, email: "ben@example.org" },
      { pid: 2, email: "ben@example.org" },
    ]);
    const tiers = Object.fromEntries(v.people.map((p) => [p.email, p.tier]));
    expect(tiers).toMatchObject({ "cy@example.org": "junior", "dee@example.org": "reciprocal", "eve@example.org": "senior" });
    expect(v.people.find((p) => p.email === "ada@example.org")).toEqual({
      email: "ada@example.org",
      name: "Ada Chair",
      tier: "senior",
      roles: ["pc", "chair"],
    });
    // Non-PC comment authors (the response) are people too, named by email.
    expect(v.people.find((p) => p.email === "author2@example.org")).toMatchObject({ name: "author2@example.org", roles: [] });
    store.close();
  });

  it("maps reviews: scores from the configured fields, ratings, times, version history oldest first", async () => {
    const { store } = await twoSyncs();
    const v = buildSnapshot(store, { fields: FIELDS, acRole: { kind: "meta" } });
    const r12 = v.reviews.find((r) => r.rid === 12)!;
    expect(r12).toMatchObject({
      pid: 1,
      email: "cy@example.org",
      rtype: 4,
      status: "complete",
      ordinal: "A",
      merit: 3,
      expertise: 3,
      wordCount: 3 + 4,
      ratedShort: false,
      modifiedAt: (s(T2) - 3600) * 1000,
      firstSeenAt: 1_890_000_012_000,
    });
    expect(r12.versions).toEqual([
      { seenAt: 1_890_000_012_000, merit: 2, expertise: 3, status: "complete" },
      { seenAt: (s(T2) - 3600) * 1000, merit: 3, expertise: 3, status: "complete" },
    ]);
    expect(v.reviews.find((r) => r.rid === 13)).toMatchObject({ ratedShort: true, ratedVague: false });
    // Draft with null scores; metareview with no ordinal.
    expect(v.reviews.find((r) => r.rid === 22)).toMatchObject({ status: "draft", merit: null, expertise: null, firstCompleteSeenAt: null });
    expect(v.reviews.find((r) => r.rid === 11)).toMatchObject({ rtype: 5, status: "empty", merit: null, modifiedAt: null });
    // Swapping the merit field re-maps the view.
    const swapped = buildSnapshot(store, { fields: { merit: "RevExp", expertise: "OveMer" }, acRole: { kind: "meta" } });
    expect(swapped.reviews.find((r) => r.rid === 12)).toMatchObject({ merit: 3, expertise: 3 });
    expect(swapped.reviews.find((r) => r.rid === 13)).toMatchObject({ merit: 4, expertise: 4 });
    store.close();
  });

  it("maps comments: earliest time across edits, mentions, responses, drafts; deleted ones are left out", async () => {
    const { store } = await twoSyncs();
    const v = buildSnapshot(store, { fields: FIELDS, acRole: { kind: "meta" } });
    const byCid = new Map(v.comments.map((c) => [c.cid, c]));
    expect([...byCid.keys()].sort()).toEqual([101, 102, 202, 203]);
    // Edited after the first sync: time stays the first-seen modified_at.
    expect(byCid.get(102)).toMatchObject({ time: 1_890_000_102_000, approximate: true, mentions: ["eve@example.org"], wordCount: 8 });
    expect(byCid.get(101)).toMatchObject({ mentions: ["cy@example.org"], isResponse: false, draft: false });
    // New at the second sync: the earlier of first_seen_at (T2) and modified_at.
    expect(byCid.get(202)).toMatchObject({ time: (s(T2) - 60) * 1000, approximate: false, draft: true });
    expect(byCid.get(203)).toMatchObject({ isResponse: true, email: "author2@example.org" });
    store.close();
  });

  it("filters by pid for the drawer", async () => {
    const { store } = await twoSyncs();
    const v = buildSnapshot(store, { fields: FIELDS, acRole: { kind: "meta" }, pids: [2] });
    expect(v.papers.map((p) => p.pid)).toEqual([2]);
    expect(new Set(v.reviews.map((r) => r.pid))).toEqual(new Set([2]));
    expect(new Set(v.comments.map((c) => c.pid))).toEqual(new Set([2]));
    expect(v.acs).toEqual([{ pid: 2, email: "ben@example.org" }]);
    expect(buildSnapshot(store, { fields: FIELDS, acRole: { kind: "meta" }, pids: [] }).papers).toEqual([]);
    store.close();
  });

  it("feeds the rules engine: the score change is movement, the decided paper fires nothing", async () => {
    const { store } = await twoSyncs();
    const ev = evaluateAll(buildSnapshot(store, { fields: FIELDS, acRole: { kind: "meta" } }), contextAt("2030-02-19T12:00"));
    expect(ev.byPid.get(3)!.fired).toEqual([]);
    expect(ev.facts.get(1)!.decided).toBe(true);
    expect(ev.facts.get(2)!.responses.map((c) => c.cid)).toEqual([203]);
    store.close();
  });

  it("parses scores", () => {
    expect([scoreNumber(3), scoreNumber("4"), scoreNumber(" 2 "), scoreNumber("B"), scoreNumber(null), scoreNumber(undefined)]).toEqual([
      3, 4, 2, null, null, null,
    ]);
  });
});

describe("buildSnapshot at scale", () => {
  it("uses a constant number of statements (no N+1) and stays fast", async () => {
    // SCALE=1 npm run test:unit: the AGENTS.md size (2,400 papers, ~10k reviews).
    const PAPERS = process.env.SCALE === "1" ? 2400 : 600;
    const hc = new FakeHotcrp();
    for (let i = 0; i < 20; i++) hc.people.push({ name: `Area Chair${i}`, email: `ac${i}@example.org` });
    for (let i = 0; i < 300; i++) hc.people.push({ name: `Rev Iewer${i}`, email: `r${i}@example.org` });
    let rid = 1;
    let cid = 1;
    for (let pid = 1; pid <= PAPERS; pid++) {
      hc.papersList.push({ pid, title: `Synthetic paper ${pid}` });
      hc.review({ pid, rid: rid++, rtype: 5, reviewer_email: `ac${pid % 20}@example.org`, status: "empty" });
      for (let k = 0; k < 3; k++) {
        hc.review({ pid, rid: rid++, reviewer_email: `r${(pid * 3 + k) % 300}@example.org`, OveMer: 1 + ((pid + k) % 5), RevExp: 3, PapSum: "Words here.", modified_at: 1_890_000_000 + rid });
      }
      for (let k = 0; k < 4; k++) {
        hc.comment({ pid, cid: cid++, author_email: `r${(pid * 3 + k) % 300}@example.org`, text: "@Rev Iewer1 ok", modified_at: 1_890_000_000 + cid });
      }
    }
    const store = memoryStore();
    await sync(store, hc, T1);
    for (const r of hc.reviewList.filter((x) => x.rid % 7 === 0)) Object.assign(r, { OveMer: 5, version: 77_000 + r.rid });
    await sync(store, hc, T3);

    const count = (pids?: number[]) => {
      let n = 0;
      const prepare = store.db.prepare.bind(store.db);
      store.db.prepare = ((sql: string) => {
        n++;
        return prepare(sql);
      }) as typeof store.db.prepare;
      const t0 = performance.now();
      const v = buildSnapshot(store, { fields: FIELDS, acRole: { kind: "meta" }, ...(pids ? { pids } : {}) });
      const ms = performance.now() - t0;
      store.db.prepare = prepare;
      return { n, ms, v };
    };
    const full = count();
    expect(full.v.papers).toHaveLength(PAPERS);
    expect(full.v.reviews).toHaveLength(PAPERS * 4);
    expect(full.v.comments).toHaveLength(PAPERS * 4);
    expect(full.v.reviews.filter((r) => r.versions.length === 2).length).toBeGreaterThan(PAPERS / 3);
    const one = count([5]);
    expect(full.n).toBe(one.n);
    expect(full.n).toBeLessThanOrEqual(6);
    console.log(`buildSnapshot: ${PAPERS} papers, ${full.v.reviews.length} reviews, ${full.v.comments.length} comments in ${full.ms.toFixed(0)} ms (${full.n} statements)`);
    // Generous bound (CI machines vary).
    expect(full.ms).toBeLessThan(5000);
    store.close();
  }, 60_000);
});
