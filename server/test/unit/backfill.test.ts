import { beforeEach, describe, expect, it } from "vitest";
import { fixedClock } from "../../src/clock.js";
import { HotcrpError } from "../../src/hotcrp/errors.js";
import type { ReviewHistory } from "../../src/hotcrp/schemas.js";
import { memoryStore, type Store } from "../../src/store/store.js";
import { historyVersions, runBackfill, TokenBucket } from "../../src/sync/backfill.js";
import { runSync } from "../../src/sync/sync.js";
import { smallWorld, type FakeHotcrp } from "./fake-source.js";

const T1 = new Date("2030-02-12T12:00:00Z");
const T2 = new Date("2030-02-13T12:00:00Z");
const noWait = () => new TokenBucket(1000, 1000);

let hc: FakeHotcrp;
let store: Store;

/** Expanded history for review 12: empty (assigned) -> merit 1 -> merit 2 (current). */
function history12(): ReviewHistory {
  const cur = hc.reviewList.find((r) => r.rid === 12)!;
  return {
    ok: true,
    pid: 1,
    rid: 12,
    versions: [
      { ...cur },
      { ...cur, version: 777, OveMer: 1, PapSum: "Older summary.", modified_at: 1_889_000_000 },
      { object: "review", pid: 1, rid: 12, version: 555, status: "empty", OveMer: null, RevExp: null, PapSum: null, ComAut: null },
    ],
  };
}

beforeEach(async () => {
  hc = smallWorld();
  store = memoryStore();
  await runSync(store.db, hc, {
    clock: fixedClock(T1),
    chunkSize: 200,
    concurrency: 2,
    tierTags: {},
    acRole: { kind: "meta" },
  });
  // Every live review gets at least a one-version history.
  for (const r of hc.reviewList) hc.histories.set(r.rid, { ok: true, pid: r.pid, rid: r.rid, versions: [{ ...r }] });
  hc.histories.set(12, history12());
});

describe("runBackfill", () => {
  it("records older versions as source=history, with their modified_at", async () => {
    const r = await runBackfill(store.db, hc, { clock: fixedClock(T2), rps: 1, bucket: noWait() });
    expect(r).toMatchObject({ ok: true, done: 7, remaining: 0, versionsNew: 2 });
    const h = store.reviewsWithHistory({ pids: [1] }).find((x) => x.rid === 12)!;
    expect(h.versions.map((v) => [v.vtag, v.source, v.status, v.scores.OveMer, v.at])).toEqual([
      [555, "history", "empty", null, null],
      [777, "history", "complete", 1, 1_889_000_000],
      [1012, "snapshot", "complete", 2, 1_890_000_012],
    ]);
    expect(h.versions[1]).toMatchObject({ seenApprox: true, wordCount: 2 + 4 });
    const txt = store.db.prepare("select text from review_text where rid = 12 and vtag = 777 and field_uid = 'PapSum'").get();
    expect(txt).toEqual({ text: "Older summary." });
    // The earlier complete version refines the approximate first_complete time.
    expect(store.reviews().find((x) => x.rid === 12)!.firstCompleteSeenAt).toBe(1_889_000_000);
  });

  it("is resumable and skips reviews already backfilled", async () => {
    const a = await runBackfill(store.db, hc, { clock: fixedClock(T2), rps: 1, bucket: noWait(), limit: 3 });
    expect(a).toMatchObject({ done: 3, remaining: 4 });
    hc.calls = [];
    const b = await runBackfill(store.db, hc, { clock: fixedClock(T2), rps: 1, bucket: noWait() });
    expect(b).toMatchObject({ done: 4, remaining: 0 });
    expect(hc.calls.filter((c) => c === "reviewhistory")).toHaveLength(4);
    const c = await runBackfill(store.db, hc, { clock: fixedClock(T2), rps: 1, bucket: noWait() });
    expect(c).toMatchObject({ done: 0, remaining: 0, versionsNew: 0 });
  });

  it("stops on a fatal error and resumes later", async () => {
    hc.failOn = { reviewhistory: 2 };
    const a = await runBackfill(store.db, hc, { clock: fixedClock(T2), rps: 1, bucket: noWait() });
    expect(a).toMatchObject({ ok: false, done: 1, remaining: 6 });
    expect(a.errors[0]).toMatch(/injected failure/);
    expect(store.lastSync("backfill")).toMatchObject({ ok: false });
    hc.failOn = {};
    const b = await runBackfill(store.db, hc, { clock: fixedClock(T2), rps: 1, bucket: noWait() });
    expect(b).toMatchObject({ ok: true, done: 6, remaining: 0 });
  });

  it("skips (and retries next time) a review HotCRP says is gone", async () => {
    const orig = hc.reviewHistory.bind(hc);
    hc.reviewHistory = async (pid, rid) => {
      if (rid === 13) throw new HotcrpError("http", "GET /{p}/reviewhistory", "HTTP 404", { status: 404 });
      return orig(pid, rid);
    };
    const a = await runBackfill(store.db, hc, { clock: fixedClock(T2), rps: 1, bucket: noWait() });
    expect(a).toMatchObject({ ok: true, done: 6, remaining: 1 });
    expect(a.errors).toEqual([expect.stringMatching(/^review 13: .*404/)]);
  });

  it("stops between reviews when aborted", async () => {
    const ctl = new AbortController();
    const orig = hc.reviewHistory.bind(hc);
    hc.reviewHistory = async (pid, rid) => {
      ctl.abort();
      return orig(pid, rid);
    };
    const r = await runBackfill(store.db, hc, { clock: fixedClock(T2), rps: 1, bucket: noWait(), signal: ctl.signal });
    expect(r).toMatchObject({ ok: true, done: 1, remaining: 6 });
  });
});

describe("historyVersions (unexpanded deltas)", () => {
  const f = { scoreUids: ["OveMer", "RevExp"], textUids: ["PapSum", "ComAut"] };

  it("applies deltas onto the next-newer version; :p patches make text unknown", () => {
    const h: ReviewHistory = {
      ok: true,
      pid: 1,
      rid: 2,
      versions: [
        { object: "review", pid: 1, rid: 2, version: 30, status: "complete", OveMer: 2, RevExp: 3, PapSum: "new text", ComAut: "b", modified_at: 300 },
        { object: "review_delta", pid: 1, rid: 2, version: 20, status: "complete", OveMer: 1, "PapSum:p": "@@ -1 +1 @@" },
        { object: "review_delta", pid: 1, rid: 2, version: 10, status: "empty", OveMer: null, RevExp: null, PapSum: null, ComAut: null },
      ],
    };
    const vs = historyVersions(h, f);
    expect(vs.map((v) => [v.vtag, v.status, v.scores, v.modified_at])).toEqual([
      [30, "complete", { OveMer: 2, RevExp: 3 }, 300],
      [20, "complete", { OveMer: 1, RevExp: 3 }, null],
      [10, "empty", { OveMer: null, RevExp: null }, null],
    ]);
    expect([...vs[1]!.unknownText]).toEqual(["PapSum"]);
    expect(vs[1]!.texts.get("ComAut")).toBe("b");
    expect(vs[1]!.texts.has("PapSum")).toBe(false);
    // A full value in an older delta makes the field known again.
    expect([...vs[2]!.unknownText]).toEqual([]);
    expect(vs[2]!.texts.get("PapSum")).toBeNull();
  });
});

describe("TokenBucket", () => {
  it("spaces requests at `rate` per second", async () => {
    let t = 0;
    const waits: number[] = [];
    const b = new TokenBucket(
      2,
      1,
      () => t,
      async (ms) => {
        waits.push(ms);
        t += ms;
      },
    );
    for (let i = 0; i < 4; i++) await b.take();
    expect(waits).toEqual([500, 500, 500]);
    expect(t).toBe(1500);
  });

  it("rejects a non-positive rate", () => {
    expect(() => new TokenBucket(0)).toThrow(RangeError);
  });
});
