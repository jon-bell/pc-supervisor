// `pcs probe` unit tests (PLAN M0), with a fake fetch. The key property: the
// report never contains content, however much content the responses carry.

import { describe, expect, it } from "vitest";
import { COMMANDS } from "../../src/cli/main.js";
import { runProbe } from "../../src/probe/command.js";
import { isReadRequest, newRateLimitObservation, readOnlyFetch, WriteRefusedError } from "../../src/probe/readonly.js";
import { suggestEnv, type FormField, type ProbeReport } from "../../src/probe/report.js";
import { ident, label, note, type Safe } from "../../src/probe/safe.js";

const TOKEN = "hct_ProbeUnitTestToken0123456789abcdef";
const ENV = { PCS_HOTCRP_URL: "http://127.0.0.1:8080", PCS_HOTCRP_TOKEN: TOKEN };

// Content that must never reach the report. Single-word values are included
// on purpose: they would survive ident(), so only the collector's discipline
// keeps them out.
const S = {
  title: "Quokka Sentinel Paper Title",
  title1: "Zyxquokkatitle",
  name: "Quentin Sentinelle",
  given: "Quentinsentinelgiven",
  family: "Sentinellefamily",
  email: "quentin.sentinel@example.org",
  email2: "petra.probe@example.org",
  affiliation: "Sentinel University of Nowhere",
  reviewText: "SENTINEL REVIEW TEXT the method is unsound",
  reviewWord: "Sentinelreviewword",
  commentText: "SENTINEL COMMENT TEXT please respond",
  responseText: "SENTINEL RESPONSE TEXT from the authors",
  paperTag: "sentinelpapertag",
  commentTag: "sentinelcommenttag",
  pseudonym: "Sentinelpseudonym",
  reviewerHtml: "<a href=\"mailto:quentin.sentinel@example.org\">Quentin Sentinelle</a>",
  oddKey: "Sentinel Key With Spaces",
  history: "SENTINEL HISTORY TEXT older draft",
  reviewers: "Quentin Sentinelle, Petra Probe",
  pseudoScore: "Sentinelscoreword",
};

const json = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", "x-ratelimit-limit": "250", "x-ratelimit-remaining": "200", ...headers },
  });

const REVIEW_FORM = {
  hotcrp_version: "3.4",
  reviewform: {
    OveMer: { uid: "OveMer", name: "Overall merit", type: "radio", order: 1, required: true, values: ["Reject", "Weak reject", "Weak accept", "Accept", "Strong accept"] },
    RevExp: { uid: "RevExp", name: "Reviewer expertise", type: "radio", order: 2, values: ["No familiarity", "Some familiarity", "Knowledgeable", "Expert"] },
    PapSum: { uid: "PapSum", name: "Paper summary", type: "text", order: 3 },
  },
  papers: [],
};

function review(rid: number, extra: Record<string, unknown>) {
  return {
    object: "review",
    pid: 1,
    rid,
    version: 1000 + rid,
    rtype: 4,
    status: "complete",
    reviewer: S.reviewerHtml,
    reviewer_email: S.email,
    OveMer: 4,
    RevExp: 3,
    PapSum: S.reviewText,
    ...extra,
  };
}

type Handler = (path: string, p: URLSearchParams) => Response | undefined;

/** Routes by API path; `override` can replace any route. */
function sentinelApi(override: Handler = () => undefined): Handler {
  return (path, p) => {
    const o = override(path, p);
    if (o) return o;
    switch (path) {
      case "whoami":
        return json({ ok: true, email: S.email, given_name: S.given, family_name: S.family, affiliation: S.affiliation, roles: ["chair", "pc"] });
      case "pc":
        return json({
          ok: true,
          pc: [
            { name: S.name, email: S.email, affiliation: S.affiliation, roles: "chair", color_classes: "tag-junior" },
            { name: S.given, email: S.email2, affiliation: S.affiliation },
          ],
          tags: ["bot", "junior", "listedpc", "pc", "recip", "unlistedpc"],
        });
      case "searchaction":
        if (p.get("action") === "get/jsonrqc") return json(REVIEW_FORM);
        return new Response(`paper,action,email,title\n1,clearreview,#pc,"${S.title}"\n1,primaryreview,${S.email}\n2,clearreview,#pc,${S.title1}\n`, {
          headers: { "content-type": "text/csv" },
        });
      case "settings":
        return json({ ok: true, settings: { rf: [{ id: "s01", name: "Overall merit", type: "radio", order: 1, values: [1, 2, 3, 4, 5].map((i) => ({ id: i, symbol: i, name: `L${i}` })) }] } });
      case "search":
        if (!p.has("f")) return json({ ok: true, ids: [1, 2], search_params: `q=all&t=${p.get("t")}` });
        return json({
          ok: true,
          ids: [1, 2],
          search_params: "q=all&t=all",
          fields: [{ name: "title" }, { name: "status" }, { name: "tags" }, { name: "reviewers" }],
          papers: [
            { pid: 1, title: S.title, status: "Submitted", decision: "Accepted", tags: `${S.paperTag}#3 ~chair~${S.paperTag}`, reviewers: S.reviewers },
            { pid: 2, title: S.title1, status: "Withdrawn" },
          ],
        });
      case "reviews":
        return json({
          ok: true,
          reviews: [
            review(11, { modified_at: 1890000000, [S.oddKey]: S.reviewText }),
            review(12, { rtype: 2, status: "draft", OveMer: 1, PapSum: S.reviewWord }),
            review(13, { rtype: 1, OveMer: S.pseudoScore }),
          ],
        });
      case "comments":
        return json({
          ok: true,
          comments: [
            { object: "comment", pid: 1, cid: 1, visibility: "rev", topic: "rev", author: S.reviewerHtml, author_email: S.email, author_pseudonym: S.pseudonym, text: S.commentText, tags: [S.commentTag], modified_at: 1890000000 },
            { object: "comment", pid: 1, cid: 2, visibility: "au", response: "", draft: true, by_author: true, text: S.responseText, word_count: 6 },
          ],
        });
      case "1/reviewhistory":
        return json({ ok: true, pid: 1, rid: Number(p.get("r")), versions: [review(Number(p.get("r")), {}), { object: "review_delta", pid: 1, rid: 11, version: 7, status: "draft", PapSum: S.history }] });
      case "1/reviewrating":
        return json({ ok: true, ratings: "none", user_rating: "none" });
      default:
        return new Response("not found", { status: 404 });
    }
  };
}

interface Seen {
  method: string;
  url: URL;
}

function fakeFetch(api: Handler) {
  const seen: Seen[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    seen.push({ method, url });
    const params = method === "POST" ? new URLSearchParams(String(init?.body ?? "")) : url.searchParams;
    const path = url.pathname.replace(/^\/api\//, "");
    return api(path, params) ?? new Response("", { status: 404 });
  }) as typeof globalThis.fetch;
  return { fetch, seen };
}

async function run(args: string[], api: Handler = sentinelApi(), env: Record<string, string> = ENV) {
  const { fetch, seen } = fakeFetch(api);
  let stdout = "";
  let stderr = "";
  const code = await runProbe(args, { env, fetch, stdout: (s) => (stdout += s), stderr: (s) => (stderr += s) });
  return { code, stdout, stderr, seen };
}

function expectNoContent(out: string) {
  for (const [k, v] of Object.entries(S)) {
    expect(out, `sentinel ${k} leaked`).not.toContain(v);
  }
  expect(out).not.toMatch(/sentinel/i);
  expect(out).not.toContain("@example.org");
  expect(out).not.toContain(TOKEN);
}

describe("pcs probe: no content", () => {
  for (const fmt of [[], ["--json"], ["--markdown"]]) {
    it(`prints no sentinel content (${fmt.join(" ") || "text"})`, async () => {
      const r = await run(fmt);
      expect(r.stderr).toBe("");
      expect(r.code).toBe(0);
      expectNoContent(r.stdout + r.stderr);
    });
  }

  it("still reports the shape and counts", async () => {
    const r = await run(["--json"]);
    const rep = JSON.parse(r.stdout) as ProbeReport & { suggestedEnv: { name: string; value: string }[] };
    expect(rep.endpoints.every((e) => e.reachable)).toBe(true);
    expect(rep.pc).toMatchObject({ size: 2, chairs: 1, userTags: ["junior", "recip"], membersWithTags: 0, membersWithColorClasses: 1 });
    expect(rep.papers).toMatchObject({ all: 2, submitted: 2, withTags: 1, distinctTags: 2 });
    expect(rep.papers?.byStatus).toEqual([["Submitted", 1], ["Withdrawn", 1]]);
    expect(rep.assignments).toMatchObject({ rows: 3, papers: 2 });
    expect(rep.reviews).toMatchObject({ total: 3, modifiedAt: { present: 1, total: 3 } });
    expect(rep.reviews?.byTypeStatus).toEqual([["external x complete", 1], ["pc x draft", 1], ["primary x complete", 1]]);
    expect(rep.comments).toMatchObject({ total: 2, responses: 1, responseDrafts: 1, drafts: 1, byAuthor: 1, withTags: 1, wordCountNonNull: 1, modifiedAt: { present: 1, total: 2 } });
    const merit = rep.form.find((f) => f.uid === "OveMer")!;
    expect(merit.observed).toMatchObject({ present: 3, numeric: 2, min: 1, max: 4, otherStrings: 1 });
    expect(merit.settingsId).toBe("s01");
    expect(rep.history).toMatchObject({ sampled: true, versions: 2, objects: [["review", 1], ["review_delta", 1]] });
    const reviewShape = rep.shapes.find((s) => s.name === "reviews[]")!.shape;
    expect(reviewShape.otherKeys).toBe(1);
    expect(reviewShape.keys.find((k) => k.key === "modified_at")).toMatchObject({ present: 1, total: 3, types: ["integer"] });
    expect(rep.rateLimit).toMatchObject({ limit: 250, minRemaining: 200, headers: ["x-ratelimit-limit", "x-ratelimit-remaining"] });
    expect(Object.fromEntries(rep.suggestedEnv.map((e) => [e.name, e.value]))).toEqual({
      PCS_FIELD_MERIT: "OveMer",
      PCS_MERIT_ACCEPT_MIN: "3",
      PCS_FIELD_EXPERTISE: "RevExp",
      PCS_EXPERTISE_OK_MIN: "3",
      PCS_TIER_TAGS: "junior=junior,reciprocal=recip",
    });
  });

  it("masks emails in HotCRP error messages", async () => {
    const api = sentinelApi((path) =>
      path === "1/reviewrating"
        ? new Response(JSON.stringify({ ok: false, message_list: [{ status: 2, message: `<0>${S.email} cannot see this` }] }), { status: 403 })
        : undefined,
    );
    const r = await run([], api);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/FAIL GET \/\{p\}\/reviewrating/);
    expect(r.stdout).toContain("[email]");
    expectNoContent(r.stdout + r.stderr);
  });
});

describe("pcs probe: GET only", () => {
  it("sends only GET or POST-as-GET requests, to the configured host", async () => {
    const r = await run([]);
    expect(r.seen.length).toBe(11);
    for (const s of r.seen) {
      expect(isReadRequest(s.method, s.url)).toBe(true);
      expect(s.url.origin).toBe("http://127.0.0.1:8080");
    }
    expect(r.seen.filter((s) => s.method === "POST").map((s) => s.url.pathname).sort()).toEqual(["/api/comments", "/api/reviews"]);
  });

  it("readOnlyFetch refuses anything that is not a read", async () => {
    const inner = (async () => new Response("{}")) as unknown as typeof globalThis.fetch;
    const f = readOnlyFetch(inner, newRateLimitObservation());
    const base = "http://127.0.0.1:8080/api/";
    await expect(f(`${base}assigntags`, { method: "POST", body: "x" })).rejects.toBeInstanceOf(WriteRefusedError);
    await expect(f(`${base}reviews?:method:=POST`, { method: "POST" })).rejects.toBeInstanceOf(WriteRefusedError);
    await expect(f(`${base}x`, { method: "PUT" })).rejects.toBeInstanceOf(WriteRefusedError);
    await expect(f(`${base}x`, { method: "DELETE" })).rejects.toBeInstanceOf(WriteRefusedError);
    await expect(f(new Request(`${base}x`, { method: "POST", body: "y" }))).rejects.toBeInstanceOf(WriteRefusedError);
    await expect(f(`${base}reviews?:method:=GET`, { method: "POST", body: "q=1" })).resolves.toBeInstanceOf(Response);
    await expect(f(`${base}whoami`)).resolves.toBeInstanceOf(Response);
  });

  it("does not require a harness URL (the chair runs it against the real instance)", async () => {
    const r = await run([], sentinelApi(), { PCS_HOTCRP_URL: "https://hotcrp.example.invalid", PCS_HOTCRP_TOKEN: TOKEN });
    expect(r.code).toBe(0);
    expect(r.seen.every((s) => s.url.origin === "https://hotcrp.example.invalid")).toBe(true);
  });
});

describe("pcs probe: drift and failures", () => {
  it("reports a schema failure instead of throwing", async () => {
    const api = sentinelApi((path) =>
      path === "comments" ? json({ ok: true, comments: [{ object: "comment", pid: 1, cid: 1, visibility: "everyone", text: S.commentText }] }) : undefined,
    );
    const r = await run([], api);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Schema drift: GET \/comments/);
    expect(r.stdout).toMatch(/schema: comments\.\[\]\.visibility: /);
    expectNoContent(r.stdout);
  });

  it("exits nonzero with a summary when an endpoint is unreachable", async () => {
    const api = sentinelApi((path) => (path === "settings" ? new Response("{}", { status: 404 }) : undefined));
    const r = await run(["--json"], api);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/1 of 11 endpoints failed: GET \/settings\?filter=rf/);
    expect(JSON.parse(r.stdout).endpoints.find((e: { name: string }) => e.name.startsWith("GET /settings")).status).toBe(404);
  });

  it("skips the history sample when there are no reviews", async () => {
    const api = sentinelApi((path) => (path === "reviews" ? json({ ok: true, reviews: [] }) : undefined));
    const r = await run(["--json"], api);
    expect(r.code).toBe(0);
    const rep = JSON.parse(r.stdout) as ProbeReport;
    expect(rep.history.sampled).toBe(false);
    expect(rep.endpoints.find((e) => e.name === "GET /{p}/reviewhistory")).toMatchObject({ requests: 0, schema: "skipped" });
  });

  it("rejects unknown arguments and reports bad config without a stack", async () => {
    expect((await run(["--frob"])).code).toBe(2);
    const r = await run([], sentinelApi(), { PCS_HOTCRP_URL: "http://127.0.0.1:8080" });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("PCS_HOTCRP_TOKEN: required");
  });

  it("is registered as a pcs subcommand", () => {
    expect(COMMANDS.probe?.summary).toMatch(/read-only/i);
  });
});

describe("safe strings and env suggestions", () => {
  it("sanitizers drop non-config strings", () => {
    expect(ident("OveMer")).toBe("OveMer");
    expect(ident("a b")).toBe("?");
    expect(ident("x@example.org")).toBe("?");
    expect(label("Weak accept")).toBe("Weak accept");
    expect(label("me@example.org")).toBe("?");
    expect(label("x".repeat(61))).toBe("?");
    expect(note("mail a.b@example.org now")).toBe("mail [email] now");
  });

  it("guesses thresholds for a custom 6-point form", () => {
    const f = (uid: string, name: string, labels: string[]): FormField => ({
      uid: uid as Safe,
      name: name as Safe,
      type: "radio" as Safe,
      labels: labels as Safe[],
    });
    const rep = {
      form: [
        f("Merit", "Recommendation", ["Strong reject", "Reject", "Weak reject", "Borderline", "Weak accept", "Strong accept"]),
        f("Conf", "Reviewer confidence", ["Low", "Medium", "High"]),
      ],
      pc: { userTags: ["reserve", "jr"] },
    } as unknown as ProbeReport;
    expect(Object.fromEntries(suggestEnv(rep).map((e) => [e.name, e.value]))).toEqual({
      PCS_FIELD_MERIT: "Merit",
      PCS_MERIT_ACCEPT_MIN: "5",
      PCS_FIELD_EXPERTISE: "Conf",
      PCS_EXPERTISE_OK_MIN: "3",
      PCS_TIER_TAGS: "reserve-pool=reserve",
    });
  });
});
