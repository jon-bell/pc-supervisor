// Scale smoke test for the diff engine (AGENTS.md: 2,400 papers, 10k reviews),
// with an in-process fake HotCRP and an encrypted on-disk DB. It guards
// against accidental O(n^2) work and per-row transactions; the real
// end-to-end budget (PLAN M7) is measured against the harness.
// Default: a quarter of the size. SCALE=1 npm run test:unit runs the full size
// (measured 2026-10-07: first sync 8.5 s, unchanged re-sync 0.7 s).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { fixedClock } from "../../src/clock.js";
import { openStore } from "../../src/store/store.js";
import { runSync } from "../../src/sync/sync.js";
import { FakeHotcrp } from "./fake-source.js";

const FULL = process.env.SCALE === "1";
const PAPERS = FULL ? 2400 : 600;
const WORDS = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor".split(" ");

function text(seed: number, n: number): string {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(WORDS[(seed * 7 + i * 13) % WORDS.length]!);
  return out.join(" ");
}

function world(): FakeHotcrp {
  const f = new FakeHotcrp();
  for (let i = 0; i < 40; i++) f.people.push({ name: `Area Chair${i}`, email: `ac${i}@example.org` });
  for (let i = 0; i < 600; i++) f.people.push({ name: `Rev Iewer${i}`, email: `r${i}@example.org`, tags: i % 5 === 0 ? ["junior"] : undefined });
  let rid = 1;
  let cid = 1;
  for (let pid = 1; pid <= PAPERS; pid++) {
    f.papersList.push({ pid, title: `Synthetic paper ${pid}` });
    const ac = `ac${pid % 40}@example.org`;
    f.assignmentRows.push({ paper: pid, action: "metareview", email: ac });
    f.review({ pid, rid: rid++, rtype: 5, reviewer_email: ac, status: "empty" });
    for (let k = 0; k < 3; k++) {
      const email = `r${(pid * 3 + k) % 600}@example.org`;
      f.assignmentRows.push({ paper: pid, action: "primaryreview", email });
      f.review({ pid, rid, reviewer_email: email, OveMer: 1 + ((pid + k) % 5), RevExp: 1 + (k % 4), PapSum: text(rid, 80), ComAut: text(rid + 1, 300), modified_at: 1_890_000_000 + rid });
      rid++;
    }
    for (let k = 0; k < 6; k++) {
      f.comment({ pid, cid, author_email: k === 0 ? ac : `r${(pid * 3 + (k % 3)) % 600}@example.org`, text: `@Rev Iewer${(pid * 3) % 600} ${text(cid, 60)}`, modified_at: 1_890_000_000 + cid });
      cid++;
    }
  }
  return f;
}

const dir = mkdtempSync(join(tmpdir(), "pcs-scale-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

it(`syncs ${PAPERS} papers / ${PAPERS * 4} reviews / ${PAPERS * 6} comments, then re-syncs with zero new rows`, async () => {
  const hc = world();
  const store = openStore({ db: { path: join(dir, "scale.db"), key: "scale-test-key" } });
  const opts = (at: string) => ({
    clock: fixedClock(new Date(at)),
    chunkSize: 200,
    concurrency: 2,
    tierTags: { junior: "junior" },
    acRole: { kind: "meta" } as const,
  });
  const first = await runSync(store.db, hc, opts("2030-02-14T12:00:00Z"));
  expect(first.ok, first.errors.join("; ")).toBe(true);
  expect(first.counts.reviews_new).toBe(PAPERS * 4);
  expect(first.counts.comments_new).toBe(PAPERS * 6);

  const again = await runSync(store.db, hc, opts("2030-02-15T12:00:00Z"));
  expect(again.ok).toBe(true);
  expect(Object.keys(again.counts).sort()).toEqual(["comments_fetched", "reviews_fetched", "tag_queries"]);

  // One score change and one new comment are found.
  Object.assign(hc.reviewList[10]!, { OveMer: 5, version: 1 });
  hc.comment({ pid: 1, cid: 10_000_000, author_email: "ac1@example.org", text: "new", modified_at: 1_900_000_000 });
  const third = await runSync(store.db, hc, opts("2030-02-16T12:00:00Z"));
  expect(third.counts).toMatchObject({ review_versions_new: 1, comments_new: 1 });

  console.log(`scale sync ms: first=${first.durationMs} unchanged=${again.durationMs} small-change=${third.durationMs}`);
  // Generous bounds (CI machines vary); the M7 budget is 5 min / 2 min end to end.
  expect(first.durationMs).toBeLessThan(FULL ? 120_000 : 60_000);
  expect(again.durationMs).toBeLessThan(FULL ? 60_000 : 30_000);
  store.close();
}, 300_000);
