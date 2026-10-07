// API contract tests: every schema in src/hotcrp/schemas.ts against the live
// harness (HotCRP @ HOTCRP_REF; nightly against master). They assume only what
// scripts/harness-smoke.sh guarantees: >= 1 submitted paper with a
// metareviewer, >= 2 complete primary reviews, and >= 1 comment.
//
// Run: set -a; . ./.env.test; set +a; npm run test:integration

import { beforeAll, describe, expect, it } from "vitest";
import { HotcrpClient } from "../../src/hotcrp/client.js";
import { HotcrpError } from "../../src/hotcrp/errors.js";
import { reviewField, SearchSchema, type Comment, type Review, type RqcResponse } from "../../src/hotcrp/schemas.js";
import { harnessClient } from "../support/harness.js";

const SEARCH_FIELDS = ["title", "status", "decision", "tags", "lead", "shepherd", "manager", "reviewers", "revstat"];

let client: HotcrpClient;
let pids: number[];
let reviews: Review[];
let comments: Comment[];
let form: RqcResponse;

beforeAll(async () => {
  client = harnessClient();
  const res = await client.search({ t: "all" });
  pids = res.ids;
  [reviews, comments, form] = await Promise.all([
    client.reviews({ q: "all" }),
    client.comments({ q: "all" }),
    client.reviewForm(),
  ]);
});

describe("account and roster", () => {
  it("whoami: the harness token is a chair/sysadmin", async () => {
    const me = await client.whoami();
    expect(me.roles).toEqual(expect.arrayContaining(["chair", "sysadmin"]));
  });

  it("pc: roster parses and is synthetic (example.org)", async () => {
    const pc = await client.pc();
    expect(pc.pc.length).toBeGreaterThan(0);
    for (const m of pc.pc) expect(m.email).toMatch(/@example\.org$/);
    expect(pc.tags).toEqual(expect.arrayContaining(["pc"]));
  });
});

describe("search", () => {
  it("returns ids for t=all", () => {
    expect(pids.length).toBeGreaterThan(0);
  });

  it("returns display fields as text with format=csv", async () => {
    const res = await client.search({ t: "all", fields: SEARCH_FIELDS });
    expect(res.papers?.map((p) => p.pid)).toEqual(res.ids);
    const first = res.papers![0]!;
    expect(typeof first.title).toBe("string");
    expect(first.revstat).toMatch(/^\d+\/\d+$/);
    // `manager` is reported under the key `administrator`.
    expect(res.fields?.map((f) => f.name)).toContain("administrator");
    expect(res.fields?.map((f) => f.name)).not.toContain("manager");
  });

  it("defaults to submitted papers (t=s)", async () => {
    const res = await client.search();
    expect(res.search_params).toMatch(/(^|&)t=s(&|$)/);
  });

  it("POST-as-GET returns the same result as GET", async () => {
    const viaGet = await client.call({ path: "search", params: { q: "all", t: "all" }, schema: SearchSchema });
    const viaPost = await client.call({
      path: "search",
      params: { q: "all", t: "all" },
      postAsGet: true,
      schema: SearchSchema,
    });
    expect(viaPost.ids).toEqual(viaGet.ids);
  });
});

describe("assignments", () => {
  it("get/pcassignments: CSV rows parse; only review assignments are listed", async () => {
    const rows = await client.pcAssignments({ t: "all" });
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(pids).toContain(r.paper);
    const actions = new Set(rows.map((r) => r.action));
    expect(actions.has("clearreview")).toBe(true);
    expect(actions.has("metareview")).toBe(true);
    // Each paper's first row is clearreview with the title.
    const firstPerPaper = new Map<number, (typeof rows)[number]>();
    for (const r of rows) if (!firstPerPaper.has(r.paper)) firstPerPaper.set(r.paper, r);
    for (const r of firstPerPaper.values()) expect(r).toMatchObject({ action: "clearreview", email: "#pc" });
  });

  it("every assigned review appears in /reviews", async () => {
    const rows = (await client.pcAssignments({ t: "all" })).filter((r) => r.action !== "clearreview");
    const byKey = new Set(reviews.map((r) => `${r.pid} ${r.reviewer_email}`));
    for (const r of rows) expect(byKey).toContain(`${r.paper} ${r.email}`);
  });
});

describe("reviews", () => {
  it("parse, with complete primary reviews and a metareview", () => {
    expect(reviews.some((r) => r.rtype === 4 && r.status === "complete")).toBe(true);
    expect(reviews.some((r) => r.rtype === 5)).toBe(true);
  });

  it("carry reviewer_email, an opaque numeric version, and modified_at when complete", () => {
    for (const r of reviews) {
      expect(r.reviewer_email).toMatch(/@example\.org$/);
      expect(typeof r.version).toBe("number");
      if (r.status === "complete") expect(typeof r.modified_at).toBe("number");
    }
  });

  it("carry one key per review-form UID, with scores in range", () => {
    const uids = Object.keys(form.reviewform);
    for (const r of reviews) {
      for (const uid of uids) {
        expect(r).toHaveProperty(uid);
        const v = reviewField(r, uid);
        const labels = form.reviewform[uid]!.values;
        if (labels && typeof v === "number") {
          expect(v).toBeGreaterThanOrEqual(1);
          expect(v).toBeLessThanOrEqual(labels.length);
        }
      }
    }
  });

  it("chunked fetch (chunk size 1) equals one q=all fetch", async () => {
    const tiny = new HotcrpClient({ baseUrl: client.baseUrl, token: process.env.PCS_HOTCRP_TOKEN!, chunkSize: 1 });
    const chunked = await tiny.reviewsForPids(pids);
    expect(chunked.map((r) => r.rid).sort()).toEqual(reviews.map((r) => r.rid).sort());
  });

  it("reviewhistory: newest version first, then deltas", async () => {
    const r = reviews.find((x) => x.status === "complete")!;
    const h = await client.reviewHistory(r.pid, r.rid);
    expect(h).toMatchObject({ pid: r.pid, rid: r.rid });
    expect(h.versions[0]).toMatchObject({ object: "review", rid: r.rid, version: r.version });
    for (const v of h.versions.slice(1)) expect(v.rid).toBe(r.rid);
  });

  it("reviewrating: parses", async () => {
    const r = reviews.find((x) => x.status === "complete")!;
    const rating = await client.reviewRating(r.pid, r.rid);
    expect(rating.ratings ?? "none").toBeDefined();
  });
});

describe("comments", () => {
  it("parse, with author_email, text, and modified_at", () => {
    expect(comments.length).toBeGreaterThan(0);
    for (const c of comments) {
      expect(c.author_email).toMatch(/@example\.org$/);
      expect(typeof c.text).toBe("string");
      expect(typeof c.modified_at).toBe("number");
    }
  });

  it("chunked fetch equals one q=all fetch", async () => {
    const chunked = await client.commentsForPids(pids);
    expect(chunked.map((c) => c.cid).sort()).toEqual(comments.map((c) => c.cid).sort());
  });
});

describe("review form", () => {
  it("get/jsonrqc gives field UIDs and score labels, and no papers", () => {
    expect(form.papers).toEqual([]);
    for (const [uid, f] of Object.entries(form.reviewform)) expect(f.uid).toBe(uid);
    // The default form (env defaults PCS_FIELD_MERIT / PCS_FIELD_EXPERTISE).
    expect(form.reviewform.OveMer?.values?.length).toBe(5);
    expect(form.reviewform.RevExp?.values?.length).toBe(4);
  });

  it("settings rf lists the same fields, in the same order, with value symbols", async () => {
    const s = await client.reviewFormSettings();
    const byOrder = (a: { order?: number }, b: { order?: number }) => (a.order ?? 0) - (b.order ?? 0);
    const rqc = Object.values(form.reviewform).sort(byOrder);
    const rf = [...s.settings.rf].sort(byOrder);
    expect(rf.map((f) => f.name)).toEqual(rqc.map((f) => f.name));
    for (const [i, f] of rf.entries()) {
      if (f.values) expect(f.values.map((v) => v.name)).toEqual(rqc[i]!.values);
    }
  });
});

describe("errors", () => {
  it("an unknown search keyword is an error, not an empty result", async () => {
    await expect(client.reviews({ q: "nosuchkeyword:1" })).rejects.toMatchObject({ kind: "api" });
  });

  it("an unknown endpoint is HTTP 404", async () => {
    const err = await client.call({ path: "nosuchendpoint", schema: SearchSchema }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HotcrpError);
    expect(err).toMatchObject({ kind: "http", status: 404 });
  });

  it("a bad token is HTTP 401 and the token is not in the error", async () => {
    const bad = "hct_definitelyNotAValidToken000000000";
    const c = new HotcrpClient({ baseUrl: client.baseUrl, token: bad, maxRetries: 0 });
    const err = (await c.whoami().catch((e: unknown) => e)) as HotcrpError;
    expect(err).toMatchObject({ kind: "http", status: 401 });
    expect(err.message).not.toContain(bad);
  });

  it("missing parameters are reported", async () => {
    await expect(client.call({ path: "1/reviewrating", schema: SearchSchema })).rejects.toThrow(/Parameter missing/);
  });
});
