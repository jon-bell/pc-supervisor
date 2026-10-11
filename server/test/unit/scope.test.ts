import { describe, expect, it } from "vitest";
import { HotcrpClient } from "../../src/hotcrp/client.js";
import { MAX_SEARCH_LENGTH, scopedQuery, searchProblem, strictSearchProblem } from "../../src/hotcrp/scope.js";
import { safeParenthesize } from "../../src/hotcrp/search-parens.js";

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

describe("scopedQuery keeps HotCRP's meaning of the query", () => {
  it("THEN, HIGHLIGHT, NOT, quotes, ranges and modifiers are wrapped whole", () => {
    expect(scopedQuery("#s", "1-3 THEN 5-6")).toBe("(#s) AND (1-3 THEN 5-6)");
    expect(scopedQuery("#s", "#a HIGHLIGHT #b")).toBe("(#s) AND (#a HIGHLIGHT #b)");
    expect(scopedQuery("#s", '-ti:"x (y" sort:-status')).toBe('(#s) AND (-ti:"x (y" sort:-status)');
    expect(scopedQuery("#s", "(#a OR #b)")).toBe("(#s) AND (#a OR #b)");
  });

  it("an unbalanced query means what it means to HotCRP alone", () => {
    // HotCRP ignores a stray ), and closes an unclosed ( or ".
    expect(scopedQuery("#s", "5) OR 7")).toBe("(#s) AND (5 OR 7)");
    expect(scopedQuery("#s", "(5 OR 7")).toBe("(#s) AND (5 OR 7)");
    expect(scopedQuery("#s", 'ti:"open')).toBe('(#s) AND (ti:"open")');
    expect(scopedQuery("#s", "sort:[OveMer variance")).toBe("(#s) AND (sort:[OveMer variance])");
  });
});

describe("safeParenthesize (port of SearchParser::safe_parenthesize)", () => {
  it("wraps, or keeps one top-level group as is", () => {
    expect(safeParenthesize("#a")).toBe("(#a)");
    expect(safeParenthesize("(#a OR #b)")).toBe("(#a OR #b)");
    expect(safeParenthesize("(#a) OR (#b)")).toBe("((#a) OR (#b))");
    expect(safeParenthesize("")).toBe("(*)");
  });

  it("drops unmatched closers, closes unclosed brackets innermost first", () => {
    expect(safeParenthesize(")#a")).toBe("(#a)");
    expect(safeParenthesize("#a ] b")).toBe("(#a  b)");
    expect(safeParenthesize("f:([x")).toBe("(f:([x]))");
    expect(safeParenthesize("show:max(OveMer")).toBe("(show:max(OveMer))");
    expect(safeParenthesize("(a [b) c")).toBe("((a [b]) c)");
  });

  it("quotes: brackets inside don't count, backslash escapes, curly quotes count", () => {
    expect(safeParenthesize('ti:"a ) b"')).toBe('(ti:"a ) b")');
    // The escaped quote keeps the string open, so its ) stays.
    expect(safeParenthesize('ti:"a \\" ) b"')).toBe('(ti:"a \\" ) b")');
    expect(safeParenthesize('ti:"a \\" b')).toBe('(ti:"a \\" b")');
    expect(safeParenthesize("ti:\u201ca ) b\u201d")).toBe("(ti:\u201ca ) b\u201d)");
    expect(safeParenthesize('ti:"x\\')).toBe('(ti:"x\\\\")');
  });

  it("unicode, &, +, % and # pass through untouched", () => {
    expect(safeParenthesize("ti:caf\u00e9 & au:m\u00fcller + 100% #t#2")).toBe("(ti:caf\u00e9 & au:m\u00fcller + 100% #t#2)");
  });
});

describe("searchProblem", () => {
  it("accepts whatever HotCRP accepts, unbalanced brackets and quotes included", () => {
    for (const q of ["#shadow", "(#a OR #b) -#c", 'ti:"x (y"', "1-20 OR re:any", "", "#a) OR (#b", "((#a)", 'ti:"x', "a\tb"]) {
      expect(searchProblem(q)).toBeNull();
    }
  });

  it("names what HotCRP can't take", () => {
    expect(searchProblem("a\u0001b")).toMatch(/control character/);
    expect(searchProblem("x".repeat(MAX_SEARCH_LENGTH + 1))).toMatch(/longer than/);
  });

  it("strictSearchProblem (PCS_PAPER_SEARCH) also refuses unbalanced searches", () => {
    expect(strictSearchProblem("#a) OR (#b")).toMatch(/\) without a matching \(/);
    expect(strictSearchProblem("((#a)")).toMatch(/\( without a matching \)/);
    expect(strictSearchProblem('ti:"x')).toMatch(/unclosed double quote/);
    expect(strictSearchProblem('ti:"a \\" (b"')).toBeNull();
    expect(strictSearchProblem("a\nb")).toBeNull();
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
