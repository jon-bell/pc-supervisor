import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { fixedClock } from "../../src/clock.js";
import { HotcrpClient, parseRetryAfter, type HotcrpClientOptions } from "../../src/hotcrp/client.js";
import { HotcrpError } from "../../src/hotcrp/errors.js";

const TOKEN = "hct_UnitTestSecretToken0123456789abcdef";
const BASE = "http://127.0.0.1:8080";

interface Seen {
  url: URL;
  method: string;
  headers: Headers;
  body: string;
}

type Reply = Response | Error | ((req: Seen) => Response | Promise<Response>);

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

/** A client whose fetch replays `replies` in order and records requests. */
function fake(replies: Reply[], opts: Partial<HotcrpClientOptions> = {}) {
  const seen: Seen[] = [];
  const sleeps: number[] = [];
  const queue = [...replies];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const req: Seen = {
      url: new URL(String(input)),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: init?.body ? String(init.body) : "",
    };
    seen.push(req);
    const r = queue.shift();
    if (r === undefined) throw new Error("fake fetch: no more replies");
    if (r instanceof Error) throw r;
    return typeof r === "function" ? r(req) : r;
  }) as typeof globalThis.fetch;
  const client = new HotcrpClient({
    baseUrl: BASE,
    token: TOKEN,
    fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0.5,
    ...opts,
  });
  return { client, seen, sleeps };
}

const WHOAMI = { ok: true, email: "admin@example.org", roles: ["chair", "pc", "sysadmin"] };

async function caught(p: Promise<unknown>): Promise<HotcrpError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof HotcrpError) return e;
    throw e;
  }
  throw new Error("expected HotcrpError");
}

describe("requests", () => {
  it("sends bearer auth and pretty=0 to <base>/api/<path>", async () => {
    const { client, seen } = fake([json(WHOAMI)]);
    await expect(client.whoami()).resolves.toMatchObject({ email: "admin@example.org" });
    expect(seen[0]!.url.href).toBe(`${BASE}/api/whoami?pretty=0`);
    expect(seen[0]!.method).toBe("GET");
    expect(seen[0]!.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
  });

  it("keeps a base path and strips a trailing slash", async () => {
    const { client, seen } = fake([json(WHOAMI)], { baseUrl: "http://localhost:8080/conf/" });
    await client.whoami();
    expect(seen[0]!.url.pathname).toBe("/conf/api/whoami");
  });

  it("sends bulk reads as POST-as-GET with a form body", async () => {
    const { client, seen } = fake([json({ ok: true, reviews: [] })]);
    await client.reviews({ q: "1-200", t: "all" });
    const req = seen[0]!;
    expect(req.method).toBe("POST");
    expect(req.url.searchParams.get(":method:")).toBe("GET");
    expect(req.url.searchParams.has("q")).toBe(false);
    const form = new URLSearchParams(req.body);
    expect(form.get("q")).toBe("1-200");
    expect(form.get("t")).toBe("all");
    expect(form.get("pretty")).toBe("0");
  });

  it("switches long GETs to POST-as-GET automatically", async () => {
    const { client, seen } = fake([json({ ok: true, ids: [], search_params: "q=x&t=s" })], { maxGetUrlLength: 100 });
    await client.search({ q: "x".repeat(200) });
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.url.searchParams.get(":method:")).toBe("GET");
  });

  it("passes forceShow=0 when configured to respect conflicts", async () => {
    const { client, seen } = fake([json({ ok: true, comments: [] })], { forceShow: false });
    await client.comments({ q: "1-5" });
    expect(new URLSearchParams(seen[0]!.body).get("forceShow")).toBe("0");
  });

  it("builds search fields with format=csv and checks the scope echo", async () => {
    const { client, seen } = fake([
      json({ ok: true, ids: [1], search_params: "q=all&t=all", papers: [{ pid: 1, title: "T", status: "Submitted" }] }),
      json({ ok: true, ids: [], search_params: "q=all&t=none" }),
    ]);
    const res = await client.search({ t: "all", fields: ["title", "status"] });
    expect(res.papers?.[0]).toEqual({ pid: 1, title: "T", status: "Submitted" });
    expect(seen[0]!.url.searchParams.get("f")).toBe("title status");
    expect(seen[0]!.url.searchParams.get("format")).toBe("csv");
    const err = await caught(client.search({ t: "all" }));
    expect(err.message).toMatch(/asked for t=all but HotCRP searched t=none/);
  });

  it("parses pcassignments CSV into typed rows", async () => {
    const csv = 'paper,action,email,title\n1,clearreview,"#pc",Smoke Paper\n1,metareview,ac1@example.org\n';
    const { client } = fake([new Response(csv, { headers: { "content-type": "text/csv" } })]);
    await expect(client.pcAssignments()).resolves.toEqual([
      { paper: 1, action: "clearreview", email: "#pc", title: "Smoke Paper" },
      { paper: 1, action: "metareview", email: "ac1@example.org" },
    ]);
  });

  it("fetches bulk data in pid chunks, bounded by concurrency", async () => {
    let inFlight = 0;
    let peak = 0;
    const reply = async (req: Seen) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight--;
      const q = new URLSearchParams(req.body).get("q")!;
      const [lo] = q.split("-").map(Number);
      return json({ ok: true, comments: [{ object: "comment", pid: lo, cid: lo, visibility: "rev" }] });
    };
    const { client, seen } = fake(Array.from({ length: 5 }, () => reply), { chunkSize: 2, concurrency: 2 });
    const out = await client.commentsForPids([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(seen.map((s) => new URLSearchParams(s.body).get("q")).sort()).toEqual(["1-2", "3-4", "5-6", "7-8", "9"]);
    expect(out.map((c) => c.pid)).toEqual([1, 3, 5, 7, 9]);
    expect(peak).toBe(2);
  });

  it("refuses a tag write without allowWrites, before any request (PLAN M8)", async () => {
    const { client, seen } = fake([]);
    const opts = { dryRun: false } as unknown as { dryRun: false; allowWrites: true };
    const err = await caught(client.assignTags([{ pid: 1, op: "add" }], "chair-attention", opts));
    expect(err.kind).toBe("writes_disabled");
    const err2 = await caught(
      client.assignTags([{ pid: 1, op: "add" }], "chair-attention", { dryRun: false, allowWrites: "yes" } as unknown as { dryRun: false; allowWrites: true }),
    );
    expect(err2.kind).toBe("writes_disabled");
    expect(seen).toHaveLength(0);
  });

  it("tag dry run: POST /assign?dry_run=1 with a JSON body; returns the diff HotCRP reports", async () => {
    const { client, seen } = fake([
      json({
        ok: true,
        dry_run: true,
        valid: true,
        assignment_count: 2,
        assignment_header: ["pid", "action", "tag"],
        assignments: [
          { pid: 5, action: "tag", tag: "chair-attention" },
          { pid: 3, action: "cleartag", tag: "Chair-Attention" },
        ],
      }),
    ]);
    const diff = await client.assignTags(
      [
        { pid: 5, op: "add" },
        { pid: 4, op: "add" },
        { pid: 3, op: "remove" },
      ],
      "chair-attention",
      { dryRun: true },
    );
    expect(diff).toEqual({ gain: [5], lose: [3] });
    const req = seen[0]!;
    expect(req.method).toBe("POST");
    expect(req.url.pathname).toBe("/api/assign");
    expect(req.url.searchParams.get("dry_run")).toBe("1");
    expect(req.url.searchParams.get("format")).toBe("json");
    expect(req.url.searchParams.get(":method:")).toBeNull();
    expect(req.headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(req.body)).toEqual([
      { pid: 5, action: "tag", tag: "chair-attention" },
      { pid: 4, action: "tag", tag: "chair-attention" },
      { pid: 3, action: "cleartag", tag: "chair-attention" },
    ]);
  });

  it("a confirmed tag write omits dry_run, never retries, and rejects a non-dry-run answer to a dry run", async () => {
    const { client, seen } = fake([new Response("", { status: 503 })]);
    const err = await caught(client.assignTags([{ pid: 1, op: "add" }], "chair-attention", { dryRun: false, allowWrites: true }));
    expect(err.kind).toBe("http");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url.searchParams.has("dry_run")).toBe(false);

    const { client: c2 } = fake([json({ ok: true, valid: true, assignments: [] })]);
    expect((await caught(c2.assignTags([{ pid: 1, op: "add" }], "chair-attention", { dryRun: true }))).kind).toBe("protocol");
    const { client: c3 } = fake([json({ ok: false, message_list: [{ status: 2, message: "<0>Submission #99 does not exist" }] })]);
    expect((await caught(c3.assignTags([{ pid: 99, op: "add" }], "chair-attention", { dryRun: true }))).message).toMatch(/#99 does not exist/);
  });

  it("validates tag changes locally", async () => {
    const { client, seen } = fake([]);
    await expect(client.assignTags([{ pid: 1, op: "add" }], "bad tag", { dryRun: true })).rejects.toThrow(/invalid tag/);
    await expect(client.assignTags([{ pid: 1, op: "add" }], "~private", { dryRun: true })).rejects.toThrow(/invalid tag/);
    await expect(client.assignTags([], "chair-attention", { dryRun: true })).rejects.toThrow(/no tag changes/);
    await expect(client.assignTags([{ pid: 0, op: "add" }], "chair-attention", { dryRun: true })).rejects.toThrow(/invalid pid/);
    await expect(
      client.assignTags(
        [
          { pid: 2, op: "add" },
          { pid: 2, op: "remove" },
        ],
        "chair-attention",
        { dryRun: true },
      ),
    ).rejects.toThrow(/twice/);
    expect(seen).toHaveLength(0);
  });
});

describe("retries", () => {
  it("retries 5xx with exponential backoff and full jitter", async () => {
    const { client, sleeps } = fake([new Response("", { status: 502 }), new Response("", { status: 503 }), json(WHOAMI)]);
    await client.whoami();
    // random() = 0.5: 0.5 * 500 * 2^0, 0.5 * 500 * 2^1
    expect(sleeps).toEqual([250, 500]);
  });

  it("caps the backoff", async () => {
    const replies = Array.from({ length: 4 }, () => new Response("", { status: 500 }));
    const { client, sleeps } = fake([...replies, json(WHOAMI)], { retryBaseMs: 1000, retryMaxMs: 3000, random: () => 1 });
    await client.whoami();
    expect(sleeps).toEqual([1000, 2000, 3000, 3000]);
  });

  it("honors Retry-After on 429", async () => {
    const { client, sleeps } = fake([new Response("", { status: 429, headers: { "retry-after": "7" } }), json(WHOAMI)]);
    await client.whoami();
    expect(sleeps).toEqual([7000]);
  });

  it("fails fast when Retry-After is too long to wait", async () => {
    const { client, sleeps } = fake([new Response("", { status: 429, headers: { "retry-after": "3600" } })]);
    const err = await caught(client.whoami());
    expect(err.kind).toBe("rate_limit");
    expect(err.message).toMatch(/wait 3600 s/);
    expect(sleeps).toEqual([]);
  });

  it("gives up after maxRetries", async () => {
    const replies = Array.from({ length: 3 }, () => new Response("", { status: 500 }));
    const { client, seen } = fake(replies, { maxRetries: 2 });
    const err = await caught(client.whoami());
    expect(err).toMatchObject({ kind: "http", status: 500 });
    expect(err.message).toMatch(/after 3 attempts/);
    expect(seen).toHaveLength(3);
  });

  it("retries network errors and timeouts", async () => {
    const timeout = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    const { client, seen } = fake([new TypeError("fetch failed"), timeout, json(WHOAMI)]);
    await client.whoami();
    expect(seen).toHaveLength(3);
  });

  it("reports a timeout as kind=timeout", async () => {
    const timeout = Object.assign(new Error("aborted"), { name: "TimeoutError" });
    const { client } = fake([timeout], { maxRetries: 0, timeoutMs: 5 });
    await expect(caught(client.whoami())).resolves.toMatchObject({ kind: "timeout" });
  });

  it("does not retry 4xx", async () => {
    const { client, seen } = fake([
      json({ ok: false, message_list: [{ status: 2, message: "<0>Unauthorized" }] }, { status: 401 }),
    ]);
    const err = await caught(client.whoami());
    expect(err).toMatchObject({ kind: "http", status: 401 });
    expect(err.message).toBe("HotCRP GET /whoami: HTTP 401: Unauthorized");
    expect(seen).toHaveLength(1);
  });

  it("refuses redirects instead of following them", async () => {
    const { client } = fake([new Response(null, { status: 301, headers: { location: "https://elsewhere.example.org/" } })]);
    const err = await caught(client.whoami());
    expect(err.message).toMatch(/redirect \(301\) to https:\/\/elsewhere\.example\.org/);
  });
});

describe("validation", () => {
  it("names the endpoint and the Zod issues on schema mismatch", async () => {
    const { client } = fake([json({ ok: true, reviews: [{ object: "review", pid: "one", rid: 2, status: "weird" }] })]);
    const err = await caught(client.reviews({ q: "1" }));
    expect(err.kind).toBe("schema");
    expect(err.endpoint).toBe("GET /reviews");
    expect(err.message).toMatch(/^HotCRP GET \/reviews: response doesn't match schema:/);
    expect(err.message).toMatch(/reviews\.0\.pid:/);
    expect(err.message).toMatch(/reviews\.0\.status:/);
  });

  it("does not quote response content in schema errors", async () => {
    const { client } = fake([json({ ok: true, comments: [{ object: "comment", pid: 1, cid: 1, visibility: "rev", text: 42 }] })]);
    const err = await caught(client.comments({ q: "1" }));
    expect(err.message).toMatch(/comments\.0\.text/);
    expect(err.message).not.toContain("42");
  });

  it("throws on ok=false even with HTTP 200", async () => {
    const { client } = fake([json({ ok: false, message_list: [{ status: 2, field: "r", message: "<0>Parameter missing" }] })]);
    const err = await caught(client.reviewRating(1, 2));
    expect(err).toMatchObject({ kind: "api", endpoint: "GET /{p}/reviewrating" });
    expect(err.message).toMatch(/r: Parameter missing/);
  });

  it("throws on search warnings (an unknown keyword silently returns nothing)", async () => {
    const { client } = fake([
      json({ ok: true, reviews: [], message_list: [{ status: 1, field: "q", message: "<0>Unknown search keyword ‘pid:’" }] }),
    ]);
    const err = await caught(client.reviews({ q: "pid:1" }));
    expect(err.kind).toBe("api");
    expect(err.message).toMatch(/Unknown search keyword/);
  });

  it("rejects non-JSON bodies", async () => {
    const { client } = fake([new Response("<html>oops</html>", { status: 200 })]);
    await expect(caught(client.whoami())).resolves.toMatchObject({ kind: "protocol" });
  });

  it("accepts a JSON error body from a CSV endpoint", async () => {
    const { client } = fake([json({ ok: false, message_list: [{ status: 2, message: "<0>Permission denied" }] })]);
    const err = await caught(client.pcAssignments());
    expect(err.message).toMatch(/Permission denied/);
  });
});

describe("token secrecy", () => {
  it("never puts the token in error messages or causes", async () => {
    const leaky = new TypeError(`fetch failed for Bearer ${TOKEN}`, { cause: new Error(`header ${TOKEN}`) });
    const echo = json({ ok: false, message_list: [{ status: 2, message: `<0>Bad token ${TOKEN}` }] }, { status: 400 });
    const schemaEcho = json({ ok: true, email: 5, [TOKEN]: 1 });
    const { client } = fake([leaky, echo, schemaEcho], { maxRetries: 0 });
    for (let i = 0; i < 3; i++) {
      const err = await caught(client.whoami());
      expect(inspect(err, { depth: 5 })).not.toContain(TOKEN);
      expect(String(err.cause ?? "")).not.toContain(TOKEN);
      expect(err.message).not.toContain(TOKEN);
    }
  });

  it("never puts the token in events", async () => {
    const events: string[] = [];
    const { client } = fake([new TypeError(`boom ${TOKEN}`), json(WHOAMI)], {
      onEvent: (e) => events.push(JSON.stringify(e)),
    });
    await client.whoami();
    expect(events.length).toBeGreaterThan(2);
    expect(events.join("\n")).not.toContain(TOKEN);
  });

  it("hides the token from inspect and JSON", () => {
    const { client } = fake([]);
    expect(inspect(client, { showHidden: true, depth: 10 })).not.toContain(TOKEN);
    expect(JSON.stringify(client)).not.toContain(TOKEN);
    expect(JSON.stringify({ ...client })).not.toContain(TOKEN);
  });
});

describe("parseRetryAfter", () => {
  it("parses seconds and HTTP dates", () => {
    const clock = fixedClock(new Date("2030-01-01T00:00:00Z"));
    expect(parseRetryAfter("12", clock)).toBe(12_000);
    expect(parseRetryAfter("Tue, 01 Jan 2030 00:00:30 GMT", clock)).toBe(30_000);
    expect(parseRetryAfter("Mon, 31 Dec 2029 00:00:00 GMT", clock)).toBe(0);
    expect(parseRetryAfter(null, clock)).toBeUndefined();
    expect(parseRetryAfter("soon", clock)).toBeUndefined();
  });
});
