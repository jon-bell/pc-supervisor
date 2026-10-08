// The filter box's completion engine (web/src/search-complete.ts): the
// token under the caret, ranking, and how accepting edits the query.
// Synthetic data only.
import { describe, expect, it } from "vitest";
import { applySuggestion, isComplete, matchRank, MAX_SUGGESTIONS, suggest, tokenAt, type CompletionData } from "../../src/search-complete";

const DATA: CompletionData = {
  tags: [
    { tag: "discuss", count: 40, values: [] },
    { tag: "order", count: 12, values: ["1", "2", "3"] },
    { tag: "~mine", count: 5, values: [] },
    { tag: "disagree", count: 3, values: [] },
    { tag: "dbl-check", count: 1, values: [] },
  ],
  pc: [
    { email: "ada@example.org", name: "Ada Lovelace" },
    { email: "rex.one@example.org", name: "Rex One" },
  ],
  keywords: [
    { text: "re:", hint: "reviewer", aliases: ["r", "rev", "review"], values: "pc", fixed: ["any", "none", "me"] },
    { text: "dec:", hint: "decision", aliases: ["decision"], values: "dec", fixed: ["any", "none", "yes", "no"] },
    { text: "#", hint: "tagged", values: "tag" },
    { text: "tag:", hint: "tagged", values: "tag" },
    { text: "OveMer:", hint: "score: Overall merit (1–5)" },
    { text: "lead:", hint: "discussion lead", values: "pc", fixed: ["any", "none"] },
    { text: "ti:", hint: "title" },
  ],
  operators: [
    { text: "OR", hint: "" },
    { text: "THEN", hint: "" },
    { text: "HIGHLIGHT", hint: "" },
  ],
  values: [
    { text: "dec:Accepted", count: 30 },
    { text: 'dec:"Major revision"', count: 4 },
    { text: "OveMer:>=4", hint: "at least 4" },
    { text: "OveMer:4", hint: "4. Accept" },
    { text: "has:lead" },
  ],
};

const at = (q: string) => {
  const caret = q.indexOf("|");
  const query = q.replace("|", "");
  return { query, caret: caret < 0 ? query.length : caret };
};
const inserts = (q: string) => {
  const { query, caret } = at(q);
  return suggest(DATA, query, caret).items.map((s) => s.insert);
};

describe("tokenAt", () => {
  it("finds the word under the caret mid-query: after OR, -, (, before )", () => {
    expect(tokenAt("#a OR #di", 9)).toEqual({ start: 6, end: 9, prefix: "#di" });
    expect(tokenAt("5 -#di", 6)).toEqual({ start: 3, end: 6, prefix: "#di" });
    expect(tokenAt("(#a OR #di) 7", 10)).toEqual({ start: 7, end: 10, prefix: "#di" });
    expect(tokenAt("!re:a", 5)).toEqual({ start: 1, end: 5, prefix: "re:a" });
    expect(tokenAt("re:ad x", 4)).toEqual({ start: 0, end: 5, prefix: "re:a" });
    expect(tokenAt("a ", 2)).toEqual({ start: 2, end: 2, prefix: "" });
  });

  it("keeps a quoted phrase (spaces, parens, escaped and curly quotes) in one word", () => {
    expect(tokenAt('dec:"Major re', 13)).toEqual({ start: 0, end: 13, prefix: 'dec:"Major re' });
    expect(tokenAt('ti:"a (b" #o', 12)).toEqual({ start: 10, end: 12, prefix: "#o" });
    expect(tokenAt('ti:"a \\" b c', 12).start).toBe(0);
    expect(tokenAt("ti:“a b” #o", 11)).toEqual({ start: 9, end: 11, prefix: "#o" });
  });

  it("clamps the caret and handles unicode", () => {
    expect(tokenAt("#café", 99)).toEqual({ start: 0, end: 5, prefix: "#café" });
    expect(tokenAt("", 0)).toEqual({ start: 0, end: 0, prefix: "" });
  });
});

describe("matchRank", () => {
  it("orders exact < prefix < word-start < substring < subsequence", () => {
    expect(matchRank("disc", "discuss")).toBe(1);
    expect(matchRank("DISCUSS", "discuss")).toBe(0);
    expect(matchRank("check", "dbl-check")).toBe(2);
    expect(matchRank("mine", "~mine")).toBe(2);
    expect(matchRank("scu", "discuss")).toBe(3);
    expect(matchRank("dcs", "discuss")).toBe(4);
    expect(matchRank("d", "order")).toBe(3);
    expect(matchRank("x", "discuss")).toBeNull();
    expect(matchRank("zz", "discuss")).toBeNull();
  });
});

describe("suggest", () => {
  it("tags after #, by paper count, with counts", () => {
    const { items } = suggest(DATA, "#d", 2);
    expect(items.map((s) => s.insert)).toEqual(["#discuss", "#disagree", "#dbl-check", "#order"]);
    expect(items[0]).toMatchObject({ kind: "tag", count: 40, continues: false });
  });

  it("tags after tag:, -#, and inside parentheses; twiddle tags by their bare name", () => {
    expect(inserts("tag:di")).toEqual(["tag:discuss", "tag:disagree"]);
    expect(inserts("1-5 -#dis")).toEqual(["#discuss", "#disagree"]);
    expect(inserts("(#mi|)")).toEqual(["#~mine"]);
    expect(inserts("#~")).toEqual(["#~mine"]);
  });

  it("tag values after #tag#", () => {
    expect(inserts("#order#")).toEqual(["#order#1", "#order#2", "#order#3"]);
    expect(inserts("#ORDER#2")).toEqual(["#order#2"]);
    expect(inserts("#nosuch#")).toEqual([]);
  });

  it("keywords for a bare word, with aliases; operators by uppercase prefix", () => {
    expect(inserts("re")[0]).toBe("re:");
    expect(inserts("rev")).toContain("re:");
    expect(inserts("decision")).toEqual(["dec:"]);
    expect(inserts("Ove")).toEqual(["OveMer:"]);
    expect(inserts("#a T")).toContain("THEN");
    expect(inserts("#a hi")).toEqual(["HIGHLIGHT"]);
    expect(suggest(DATA, "re", 2).items[0]).toMatchObject({ kind: "keyword", continues: true });
  });

  it("values after keyword:, fixed values first, then the instance's, then PC members", () => {
    expect(inserts("dec:")).toEqual(["dec:any", "dec:none", "dec:yes", "dec:no", "dec:Accepted", 'dec:"Major revision"']);
    expect(inserts("dec:maj")).toEqual(['dec:"Major revision"']);
    expect(inserts("decision:acc")).toEqual(["decision:Accepted"]);
    expect(inserts("OveMer:>")).toEqual(["OveMer:>=4"]);
    expect(inserts("ovemer:4")).toEqual(["ovemer:4", "ovemer:>=4"]);
  });

  it("PC members by email or name after re:, lead:, …", () => {
    expect(inserts("re:ada")).toEqual(["re:ada@example.org"]);
    expect(inserts("lead:lovel")).toEqual(["lead:ada@example.org"]);
    expect(inserts("#x OR re:one")[0]).toBe("re:rex.one@example.org");
    const { items } = suggest(DATA, "re:rex", 6);
    expect(items[0]).toMatchObject({ kind: "person", hint: "Rex One" });
  });

  it("nothing for paper numbers; top tags and keywords for an empty word", () => {
    expect(inserts("1-50")).toEqual([]);
    expect(inserts("3 7")).toEqual([]);
    const empty = inserts("#a |");
    expect(empty.slice(0, 2)).toEqual(["#discuss", "#order"]);
    expect(empty).toContain("re:");
  });

  it("caps the list", () => {
    const many: CompletionData = { ...DATA, tags: Array.from({ length: 500 }, (_, i) => ({ tag: `t${i}`, count: 500 - i, values: [] })) };
    const { items } = suggest(many, "#t", 2);
    expect(items).toHaveLength(MAX_SUGGESTIONS);
    expect(items[0]!.insert).toBe("#t0");
  });
});

describe("applySuggestion", () => {
  it("replaces the whole token, keeps the - operator, adds one space", () => {
    const q = "1-5 -#dis OR 7";
    const { token, items } = suggest(DATA, q, 9);
    expect(applySuggestion(q, token, items[0]!)).toEqual({ value: "1-5 -#discuss OR 7", caret: 14 });
    const end = "#a OR #di";
    const s = suggest(DATA, end, end.length);
    expect(applySuggestion(end, s.token, s.items[0]!)).toEqual({ value: "#a OR #discuss ", caret: 15 });
  });

  it("a keyword continues: no space, caret after the colon", () => {
    const s = suggest(DATA, "#a de", 5);
    expect(applySuggestion("#a de", s.token, s.items[0]!)).toEqual({ value: "#a dec:", caret: 7 });
  });

  it("before a ) no space is added", () => {
    const q = "(#a OR #di)";
    const s = suggest(DATA, q, 10);
    expect(applySuggestion(q, s.token, s.items[0]!)).toEqual({ value: "(#a OR #discuss)", caret: 15 });
  });

  it("isComplete: the token already says it", () => {
    const s = suggest(DATA, "#discuss", 8);
    expect(isComplete("#discuss", s.token, s.items[0]!)).toBe(true);
    const t = suggest(DATA, "#disc", 5);
    expect(isComplete("#disc", t.token, t.items[0]!)).toBe(false);
  });
});
