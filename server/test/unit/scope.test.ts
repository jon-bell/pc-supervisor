import { describe, expect, it } from "vitest";
import { HotcrpClient } from "../../src/hotcrp/client.js";
import { MAX_SEARCH_LENGTH, scopedQuery, searchProblem } from "../../src/hotcrp/scope.js";

describe("scopedQuery", () => {
  it("leaves queries alone without a scope", () => {
    expect(scopedQuery("", "1-200")).toBe("1-200");
    expect(scopedQuery("  ", undefined)).toBe("all");
    expect(scopedQuery("", "NONE")).toBe("NONE");
  });

  it("ANDs the scope in, both sides parenthesized", () => {
    expect(scopedQuery("#shadow", "1-200")).toBe("(#shadow) AND (1-200)");
    expect(scopedQuery("#a OR #b", "3 7-9 40")).toBe("(#a OR #b) AND (3 7-9 40)");
    expect(scopedQuery(" #a ", " -#b ")).toBe("(#a) AND (-#b)");
  });

  it("treats all/empty as the scope alone and keeps NONE", () => {
    expect(scopedQuery("#shadow", "all")).toBe("(#shadow)");
    expect(scopedQuery("#shadow", "ALL")).toBe("(#shadow)");
    expect(scopedQuery("#shadow", undefined)).toBe("(#shadow)");
    expect(scopedQuery("#shadow", "")).toBe("(#shadow)");
    expect(scopedQuery("#shadow", "NONE")).toBe("NONE");
  });
});

describe("searchProblem", () => {
  it("accepts balanced searches, parens inside quotes included", () => {
    for (const q of ["#shadow", "(#a OR #b) -#c", 'ti:"x (y"', "1-20 OR re:any", ""]) expect(searchProblem(q)).toBeNull();
  });

  it("names what's wrong", () => {
    expect(searchProblem("#a) OR (#b")).toMatch(/\) without a matching \(/);
    expect(searchProblem("((#a)")).toMatch(/\( without a matching \)/);
    expect(searchProblem('ti:"x')).toMatch(/unclosed double quote/);
    expect(searchProblem("a\nb")).toMatch(/control character/);
    expect(searchProblem("x".repeat(MAX_SEARCH_LENGTH + 1))).toMatch(/longer than/);
  });
});

describe("HotcrpClient paperSearch", () => {
  function recording(paperSearch: string) {
    const seen: { path: string; q: string | null; rq: string | null }[] = [];
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(input));
      const raw = init?.body;
      const body = typeof raw === "string" ? new URLSearchParams(raw) : raw instanceof URLSearchParams ? raw : null;
      const get = (k: string) => u.searchParams.get(k) ?? body?.get(k) ?? null;
      const path = u.pathname.replace(/^\/api\//, "");
      const action = get("action");
      seen.push({ path: action ? `${path}?${action}` : path, q: get("q"), rq: get("rq") });
      const json: Record<string, unknown> | null =
        path === "search"
          ? { ok: true, ids: [], search_params: `q=x&t=${get("t")}`, papers: [] }
          : path === "reviews"
            ? { ok: true, reviews: [] }
            : path === "comments"
              ? { ok: true, comments: [] }
              : path === "papers"
                ? { ok: true, papers: [] }
                : null;
      if (json) return new Response(JSON.stringify(json), { status: 200, headers: { "content-type": "application/json" } });
      return new Response("", { status: 200, headers: { "content-type": "text/csv" } });
    }) as typeof globalThis.fetch;
    const client = new HotcrpClient({ baseUrl: "http://127.0.0.1:9/", token: "hct_test", paperSearch, fetch, maxRetries: 0 });
    return { client, seen };
  }

  it("scopes every paper read, and nothing else", async () => {
    const { client, seen } = recording("#shadow");
    expect(client.paperSearch).toBe("#shadow");
    await client.search({ t: "all", q: "#x" });
    await client.search({ t: "all" });
    await client.reviews({ q: "1-20", rq: "re:#junior", t: "all" });
    await client.comments({ q: "1-20", t: "all" });
    await client.papers({ q: "3 5", t: "all" });
    await client.reviewsForPids([1, 2, 3]);
    // Empty CSV bodies may not parse; the requests are what matter here.
    await client.pcAssignments({ t: "all" }).catch(() => undefined);
    await client.paperRoles("lead", { t: "all" }).catch(() => undefined);
    await client.pcConflicts({ q: "all", t: "all" }).catch(() => undefined);
    await client.allRevPrefs({ q: "all", t: "all" }).catch(() => undefined);
    expect(seen.map((s) => [s.path, s.q])).toEqual([
      ["search", "(#shadow) AND (#x)"],
      ["search", "(#shadow)"],
      ["reviews", "(#shadow) AND (1-20)"],
      ["comments", "(#shadow) AND (1-20)"],
      ["papers", "(#shadow) AND (3 5)"],
      ["reviews", "(#shadow) AND (1-3)"],
      ["searchaction?get/pcassignments", "(#shadow)"],
      ["searchaction?get/lead", "(#shadow)"],
      ["searchaction?get/pcconf", "(#shadow)"],
      ["searchaction?get/allrevpref", "(#shadow)"],
    ]);
    expect(seen[2]!.rq).toBe("re:#junior"); // the review search itself is not scoped
  });

  it("leaves the review form's q=NONE alone", async () => {
    const { client, seen } = recording("#shadow");
    await client.reviewForm().catch(() => undefined);
    expect(seen[0]).toMatchObject({ path: "searchaction?get/jsonrqc", q: "NONE" });
  });

  it("sends queries unchanged without a scope", async () => {
    const { client, seen } = recording("");
    await client.reviews({ q: "1-20", t: "all" });
    await client.search({ t: "all" });
    expect(seen.map((s) => s.q)).toEqual(["1-20", "all"]);
  });
});
