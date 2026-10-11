// PCS_PAPER_SEARCH and the sync: papers leaving the scope are gone from every
// live read; papers entering it bring their history with approximate times.
// The fake source plays a scoped client (scopePids = what the search matches).

import { beforeEach, describe, expect, it } from "vitest";
import { fixedClock } from "../../src/clock.js";
import type { AcRole } from "../../src/config.js";
import { paperAuthors } from "../../src/store/submissions.js";
import { memoryStore, type Store } from "../../src/store/store.js";
import { runSync, type SyncOptions } from "../../src/sync/sync.js";
import { buildSnapshot } from "../../src/views/snapshot.js";
import { smallWorld, type FakeHotcrp } from "./fake-source.js";

const T1 = new Date("2030-02-12T12:00:00Z");
const T2 = new Date("2030-02-20T12:00:00Z");
const T3 = new Date("2030-02-24T12:00:00Z");
const s = (d: Date) => d.getTime() / 1000;

const opts = (at: Date): SyncOptions => ({
  clock: fixedClock(at),
  chunkSize: 2,
  concurrency: 2,
  tierTags: { junior: "junior" },
  acRole: { kind: "meta" } as AcRole,
});

const meta = (store: Store, key: string) =>
  (store.db.prepare("select value from meta where key = ?").get(key) as { value: string } | undefined)?.value;

let hc: FakeHotcrp;
let store: Store;

beforeEach(() => {
  hc = smallWorld();
  store = memoryStore();
});

describe("scoped sync", () => {
  it("syncs only in-scope papers and records the search", async () => {
    hc.paperSearch = "#shadow";
    hc.scopePids = new Set([1, 2]);
    const r = await runSync(store.db, hc, opts(T1));
    expect(r.ok, r.errors.join("; ")).toBe(true);
    expect(store.papers().map((p) => p.pid)).toEqual([1, 2]);
    expect(new Set(store.reviews().map((x) => x.pid))).toEqual(new Set([1, 2]));
    expect(store.assignments().some((a) => a.pid === 3)).toBe(false);
    expect(meta(store, "paper_search")).toBe("#shadow");
  });

  it("a paper leaving the scope disappears from every live read; nothing is dropped", async () => {
    expect((await runSync(store.db, hc, opts(T1))).ok).toBe(true);
    store.db.prepare("insert into paper_author (pid, author_key, ord, email, name, first_seen_at) values (3, 'k', 0, 'auth@example.org', 'Al Author', ?)").run(s(T1));
    expect(store.papers().map((p) => p.pid)).toEqual([1, 2, 3]);

    hc.paperSearch = "#shadow";
    hc.scopePids = new Set([1, 2]);
    const r = await runSync(store.db, hc, opts(T2));
    expect(r.ok, r.errors.join("; ")).toBe(true);
    expect(r.counts).toMatchObject({ papers_deleted: 1, reviews_deleted: 1 });
    expect(store.papers().map((p) => p.pid)).toEqual([1, 2]);
    expect(store.reviews().some((x) => x.pid === 3)).toBe(false);
    expect(store.assignments().some((a) => a.pid === 3)).toBe(false);
    expect(paperAuthors(store.db).some((a) => a.pid === 3)).toBe(false);
    const snap = buildSnapshot(store, { fields: { merit: "OveMer", expertise: "RevExp" }, acRole: { kind: "meta" } });
    expect(snap.papers.map((p) => p.pid)).toEqual([1, 2]);
    expect(snap.reviews.some((x) => x.pid === 3)).toBe(false);
    // Kept, marked gone.
    expect(store.papers({ includeGone: true }).find((p) => p.pid === 3)?.deletedSeenAt).toBe(s(T2));
    expect(meta(store, "paper_search")).toBe("#shadow");
  });

  it("a paper entering the scope is restored, its unseen items timed approximately", async () => {
    hc.paperSearch = "#shadow";
    hc.scopePids = new Set([1, 2]);
    expect((await runSync(store.db, hc, opts(T1))).ok).toBe(true);

    // While out of scope, paper 3 got a new review and a comment.
    const mod = s(T2) - 3600;
    hc.review({ pid: 3, rid: 32, reviewer_email: "cy@example.org", OveMer: 2, RevExp: 2, PapSum: "Hm.", ComAut: "Weak.", modified_at: mod });
    hc.comment({ pid: 3, cid: 301, author_email: "eve@example.org", text: "Thoughts?", modified_at: mod });
    // And paper 1 got one too, while in scope.
    hc.review({ pid: 1, rid: 14, reviewer_email: "dee@example.org", OveMer: 3, RevExp: 3, PapSum: "Ok.", ComAut: "Fine.", modified_at: mod });
    hc.scopePids = new Set([1, 2, 3]);
    const r = await runSync(store.db, hc, opts(T3));
    expect(r.ok, r.errors.join("; ")).toBe(true);
    expect(store.papers().map((p) => p.pid)).toEqual([1, 2, 3]);

    const rv = new Map(store.reviews().map((x) => [x.rid, x]));
    expect(rv.get(32)).toMatchObject({ firstSeenAt: mod, firstSeenApprox: true });
    expect(rv.get(31)).toMatchObject({ firstSeenApprox: true });
    // A new review on a paper that stayed in scope is new now, exactly.
    expect(rv.get(14)).toMatchObject({ firstSeenAt: s(T3), firstSeenApprox: false });
    const cm = store.comments().find((c) => c.cid === 301);
    expect(cm).toMatchObject({ firstSeenAt: mod, firstSeenApprox: true });
    const asg = store.assignments().filter((a) => a.pid === 3);
    expect(asg.length).toBeGreaterThan(0);
    expect(asg.every((a) => a.firstSeenApprox)).toBe(true);
  });

  it("an unscoped sync records an empty search and keeps exact times for new papers", async () => {
    hc.papersList = hc.papersList.filter((p) => p.pid !== 3);
    expect((await runSync(store.db, hc, opts(T1))).ok).toBe(true);
    expect(meta(store, "paper_search")).toBe("");
    hc.papersList.push({ pid: 3, title: "Paper Three" });
    expect((await runSync(store.db, hc, opts(T2))).ok).toBe(true);
    expect(store.reviews().find((x) => x.rid === 31)).toMatchObject({ firstSeenAt: s(T2), firstSeenApprox: false });
  });
});
