// Column sort and filter (web/src/table/model.ts): the comparator, each
// filter predicate, facet counts and histograms, and the URL encoding of a
// table's state. Synthetic values only.
import { describe, expect, it } from "vitest";
import { placeBelow } from "../../src/components/Popover";
import { withSticky } from "../../src/router";
import {
  addDays,
  compareValues,
  compileFilter,
  dateRange,
  decodeFilter,
  describeFilter,
  encodeFilter,
  facetCounts,
  histogram,
  isActive,
  isTableParam,
  mean,
  nextSort,
  parseTableState,
  phaseStartOf,
  sortable,
  sortIndices,
  tableParamsKey,
  textSuggestions,
  writeTableState,
  zonedDay,
  zonedDayStart,
  type ColumnKind,
  type Filter,
  type FilterClock,
  type Sortable,
} from "../../src/table/model";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2030, 1, 26, 17, 0); // 2030-02-26 12:00 in New York
const CLOCK: FilterClock = { now: NOW, tz: "America/New_York", phaseStart: Date.UTC(2030, 1, 12, 5, 0) };

const order = (values: Sortable[], desc = false) => sortIndices(values.map((_, i) => i), [{ values, desc }]);

describe("compareValues and sortIndices", () => {
  it("compares numbers numerically, not as strings", () => {
    expect(order([10, 9, 100, 1])).toEqual([3, 1, 0, 2]);
    expect(compareValues(2, 10)).toBeLessThan(0);
  });

  it("collates strings by locale with numeric runs and case-insensitively", () => {
    expect(order(["paper 10", "Paper 9", "paper 1"])).toEqual([2, 1, 0]);
    expect(order(["Émile", "eve", "Adam"])).toEqual([2, 0, 1]);
  });

  it("orders false before true", () => {
    expect(order([true, false, true])).toEqual([1, 0, 2]);
  });

  it("puts nulls last in both directions", () => {
    expect(order([null, 3, 1, null, 2])).toEqual([2, 4, 1, 0, 3]);
    expect(order([null, 3, 1, null, 2], true)).toEqual([1, 4, 2, 0, 3]);
  });

  it("is stable: ties keep their original order, and no keys keeps the input order", () => {
    expect(order([1, 0, 1, 0, 1])).toEqual([1, 3, 0, 2, 4]);
    expect(order([1, 0, 1, 0, 1], true)).toEqual([0, 2, 4, 1, 3]);
    expect(sortIndices([4, 2, 0], [])).toEqual([4, 2, 0]);
  });

  it("applies secondary keys only to ties of the first", () => {
    const tier = ["b", "a", "b", "a"];
    const n = [1, 2, 3, 4];
    expect(sortIndices([0, 1, 2, 3], [{ values: tier, desc: false }, { values: n, desc: true }])).toEqual([3, 1, 2, 0]);
  });

  it("sorts only the given (filtered) indices", () => {
    expect(sortIndices([3, 0], [{ values: [5, 9, 9, 1], desc: false }])).toEqual([3, 0]);
  });

  it("dates sort as ms", () => {
    expect(order([Date.UTC(2030, 1, 2), Date.UTC(2030, 0, 30), null])).toEqual([1, 0, 2]);
  });
});

describe("sortable", () => {
  it("maps empty cells to null and multi-valued cells to their joined labels", () => {
    expect(sortable(null)).toBeNull();
    expect(sortable(undefined)).toBeNull();
    expect(sortable("")).toBeNull();
    expect(sortable([])).toBeNull();
    expect(sortable(Number.NaN)).toBeNull();
    expect(sortable(["SPLIT", "GONE_QUIET"], (s) => s.toLowerCase())).toBe("split, gone_quiet");
    expect(sortable("late", (s) => s.toUpperCase())).toBe("LATE");
    expect(sortable(4)).toBe(4);
  });
  it("mean of merits", () => {
    expect(mean([2, 4, 4])).toBeCloseTo(10 / 3);
    expect(mean([])).toBeNull();
  });
});

describe("nextSort", () => {
  it("cycles a plain click: ascending, descending, off", () => {
    const a = nextSort([], "sev", false);
    expect(a).toEqual([{ id: "sev", desc: false }]);
    const b = nextSort(a, "sev", false);
    expect(b).toEqual([{ id: "sev", desc: true }]);
    expect(nextSort(b, "sev", false)).toEqual([]);
  });
  it("a plain click on another column replaces the sort", () => {
    expect(nextSort([{ id: "sev", desc: true }, { id: "pid", desc: false }], "title", false)).toEqual([{ id: "title", desc: false }]);
    // ...including a column that is a secondary key.
    expect(nextSort([{ id: "sev", desc: true }, { id: "pid", desc: false }], "pid", false)).toEqual([{ id: "pid", desc: false }]);
  });
  it("shift-click adds a key, then cycles it in place", () => {
    const one = [{ id: "sev", desc: true }];
    const two = nextSort(one, "pid", true);
    expect(two).toEqual([{ id: "sev", desc: true }, { id: "pid", desc: false }]);
    const three = nextSort(two, "pid", true);
    expect(three).toEqual([{ id: "sev", desc: true }, { id: "pid", desc: true }]);
    expect(nextSort(three, "pid", true)).toEqual([{ id: "sev", desc: true }]);
    expect(nextSort(three, "sev", true)).toEqual([{ id: "pid", desc: true }]);
  });
});

const pass = (f: Filter, values: unknown[], clock = CLOCK) => {
  const p = compileFilter(f, clock);
  return values.map((v) => p(v as never));
};

describe("filter predicates", () => {
  it("categorical: any selected value matches; multi-valued cells match on any; the empty option matches empty cells", () => {
    const f: Filter = { kind: "categorical", values: ["SPLIT", "junior"], empty: false };
    expect(pass(f, ["SPLIT", ["GONE_QUIET", "SPLIT"], ["GONE_QUIET"], "senior", null, [], ""])).toEqual([true, true, false, false, false, false, false]);
    const g: Filter = { kind: "categorical", values: [], empty: true };
    expect(pass(g, ["x", null, [], "", undefined])).toEqual([false, true, true, true, true]);
    // Nothing selected matches nothing.
    expect(pass({ kind: "categorical", values: [], empty: false }, ["x", null])).toEqual([false, false]);
  });

  it("numeric: inclusive bounds, either side open; non-numbers never match", () => {
    expect(pass({ kind: "numeric", min: 2, max: 4 }, [1, 2, 3, 4, 5, null, "3", Number.NaN])).toEqual([false, true, true, true, false, false, false, false]);
    expect(pass({ kind: "numeric", min: null, max: 0 }, [-1, 0, 0.5])).toEqual([true, true, false]);
    expect(pass({ kind: "numeric", min: 2.5, max: null }, [2.4, 2.5, 100])).toEqual([false, true, true]);
  });

  it("date presets resolve against the given clock (PCS_NOW), never the wall clock", () => {
    const f: Filter = { kind: "date", preset: "last24h", from: null, to: null };
    expect(pass(f, [NOW - DAY - 1, NOW - DAY, NOW - HOUR, NOW, NOW + HOUR, null])).toEqual([false, true, true, true, false, false]);
    const week: Filter = { kind: "date", preset: "last7d", from: null, to: null };
    expect(pass(week, [NOW - 7 * DAY - 1, NOW - 6 * DAY])).toEqual([false, true]);
    const phase: Filter = { kind: "date", preset: "phase", from: null, to: null };
    expect(pass(phase, [CLOCK.phaseStart! - 1, CLOCK.phaseStart!, NOW])).toEqual([false, true, true]);
    // Another clock, another answer: the same filter at a pinned earlier now.
    expect(pass(f, [NOW - HOUR], { ...CLOCK, now: NOW - 3 * DAY })).toEqual([false]);
  });

  it("date ranges are whole days in the conference zone, both ends inclusive", () => {
    const f: Filter = { kind: "date", preset: null, from: "2030-02-20", to: "2030-02-21" };
    const start = Date.UTC(2030, 1, 20, 5, 0); // midnight in New York (EST, UTC-5)
    const end = Date.UTC(2030, 1, 22, 5, 0);
    expect(dateRange(f, CLOCK)).toEqual({ from: start, to: end });
    expect(pass(f, [start - 1, start, end - 1, end])).toEqual([false, true, true, false]);
    expect(pass({ kind: "date", preset: null, from: null, to: "2030-02-21" }, [0, end - 1, end])).toEqual([true, true, false]);
  });

  it("text: accent- and case-insensitive contains, over every value of a multi-valued cell", () => {
    const f: Filter = { kind: "text", contains: "  ZOË " };
    expect(pass(f, ["Zoe Example", "zoë", "Chloe", ["x", "Zoey"], null, 42])).toEqual([true, true, false, true, false, false]);
    expect(pass({ kind: "text", contains: "4" }, [42, "x"])).toEqual([true, false]);
  });

  it("boolean: yes or no; null never matches", () => {
    expect(pass({ kind: "boolean", value: true }, [true, false, null])).toEqual([true, false, false]);
    expect(pass({ kind: "boolean", value: false }, [true, false, null])).toEqual([false, true, false]);
  });

  it("isActive ignores empty text and open ranges", () => {
    expect(isActive({ kind: "text", contains: "  " })).toBe(false);
    expect(isActive({ kind: "numeric", min: null, max: null })).toBe(false);
    expect(isActive({ kind: "date", preset: null, from: null, to: null })).toBe(false);
    expect(isActive({ kind: "categorical", values: [], empty: false })).toBe(true);
    expect(isActive(undefined)).toBe(false);
  });
});

describe("facets, histograms, suggestions", () => {
  it("counts each value once per row, plus rows with none, restricted to the included rows", () => {
    const values = [["a", "b"], ["a", "a"], null, "b", []];
    const all = facetCounts(values);
    expect(Object.fromEntries(all.counts)).toEqual({ a: 2, b: 2 });
    expect(all.empty).toBe(2);
    const some = facetCounts(values, (i) => i !== 0);
    expect(Object.fromEntries(some.counts)).toEqual({ a: 1, b: 1 });
  });

  it("bins small integers one per value", () => {
    const h = histogram([1, 2, 2, 5]);
    expect(h).toMatchObject({ lo: 1, hi: 5, integer: true });
    expect(h.bins.map((b) => b.count)).toEqual([1, 2, 0, 0, 1]);
  });

  it("bins wide or fractional ranges into equal bins, max included in the last", () => {
    const h = histogram([0, 0.5, 1, 9.9, 10], 4);
    expect(h.integer).toBe(false);
    expect(h.bins).toHaveLength(4);
    expect(h.bins.map((b) => b.count)).toEqual([3, 0, 0, 2]);
    expect(histogram([]).bins).toEqual([]);
    expect(histogram([3, 3]).bins.map((b) => b.count)).toEqual([2]);
  });

  it("suggests distinct values containing the text, prefix matches first, then by frequency", () => {
    const values = ["Ada Lovelace", "Grace Hopper", "Ada Lovelace", ["Lovelace Fan"], null, "Bea Ada"];
    expect(textSuggestions(values, "love").map((s) => s.value)).toEqual(["Lovelace Fan", "Ada Lovelace"]);
    expect(textSuggestions(values, "ada")).toEqual([
      { value: "Ada Lovelace", count: 2 },
      { value: "Bea Ada", count: 1 },
    ]);
    expect(textSuggestions(values, "", 2)).toHaveLength(2);
  });
});

describe("chip text", () => {
  it("describes each kind with its numbers", () => {
    expect(describeFilter({ kind: "categorical", values: ["SPLIT"], empty: true }, "Reasons", (s) => s.toLowerCase())).toBe("Reasons: split, (none)");
    expect(describeFilter({ kind: "categorical", values: ["a", "b", "c", "d"], empty: false }, "AC")).toBe("AC: a, b +2 more");
    expect(describeFilter({ kind: "categorical", values: [], empty: false }, "AC")).toBe("AC: nothing selected");
    expect(describeFilter({ kind: "numeric", min: 2, max: 5 }, "Severity")).toBe("Severity 2–5");
    expect(describeFilter({ kind: "numeric", min: 3, max: 3 }, "Severity")).toBe("Severity = 3");
    expect(describeFilter({ kind: "numeric", min: 2, max: null }, "Severity")).toBe("Severity ≥ 2");
    expect(describeFilter({ kind: "numeric", min: null, max: 1.256 }, "Merit")).toBe("Merit ≤ 1.26");
    expect(describeFilter({ kind: "date", preset: "last7d", from: null, to: null }, "Last activity")).toBe("Last activity: last 7 days");
    expect(describeFilter({ kind: "date", preset: null, from: "2030-02-01", to: null }, "Last activity")).toBe("Last activity: from 2030-02-01");
    expect(describeFilter({ kind: "text", contains: " ada " }, "Title")).toBe("Title contains “ada”");
    expect(describeFilter({ kind: "boolean", value: false }, "Outcome", (v) => (v === "true" ? "bumped" : "not bumped"))).toBe("Outcome: not bumped");
  });
});

describe("URL state", () => {
  const KINDS: Record<string, ColumnKind> = { acs: "categorical", sev: "numeric", last: "date", title: "text", bumped: "boolean" };

  it("round-trips every kind through the query string", () => {
    const filters: Record<string, Filter> = {
      acs: { kind: "categorical", values: ["Ada Example", "~twiddle", "a,b|c"], empty: true },
      sev: { kind: "numeric", min: 1.5, max: null },
      last: { kind: "date", preset: null, from: "2030-02-01", to: "2030-02-10" },
      title: { kind: "text", contains: "graph & co" },
      bumped: { kind: "boolean", value: false },
    };
    const state = { sort: [{ id: "sev", desc: true }, { id: "title", desc: false }], filters };
    const q = writeTableState(new URLSearchParams("search=5+7&t=all&ac=x%40example.org"), "tri", state);
    expect(q.get("tri.sort")).toBe("-sev,title");
    expect(q.getAll("tri.acs")).toEqual(["Ada Example", "~~twiddle", "a,b|c", "~none"]);
    expect(q.get("tri.sev")).toBe("1.5..");
    expect(q.get("tri.last")).toBe("2030-02-01..2030-02-10");
    expect(q.get("tri.bumped")).toBe("no");
    // Other parameters are untouched: the paper filter and the server-side facets compose.
    expect(q.get("search")).toBe("5 7");
    expect(q.get("t")).toBe("all");
    expect(q.get("ac")).toBe("x@example.org");
    const back = parseTableState(new URLSearchParams(q.toString()), "tri", KINDS);
    expect(back).toEqual(state);
  });

  it("keeps tables apart and clears a table's own parameters only", () => {
    const q = new URLSearchParams("tri.sort=-sev&ac.sort=name&tri.sev=2..&search=x");
    const cleared = writeTableState(q, "tri", { sort: [], filters: {} });
    expect(cleared.toString()).toBe("ac.sort=name&search=x");
    expect(tableParamsKey(q, "tri")).toBe("tri.sort=-sev&tri.sev=2..");
    expect(parseTableState(q, "ac", { name: "text" }).sort).toEqual([{ id: "name", desc: false }]);
  });

  it("encodes date presets, empty selections and open ranges", () => {
    expect(encodeFilter({ kind: "date", preset: "phase", from: null, to: null })).toEqual(["phase"]);
    expect(encodeFilter({ kind: "categorical", values: [], empty: false })).toEqual(["~nothing"]);
    expect(decodeFilter("categorical", ["~nothing"])).toEqual({ kind: "categorical", values: [], empty: false });
    expect(encodeFilter({ kind: "numeric", min: null, max: -2 })).toEqual(["..-2"]);
    expect(decodeFilter("numeric", ["..-2"])).toEqual({ kind: "numeric", min: null, max: -2 });
    expect(decodeFilter("date", ["last24h"])).toEqual({ kind: "date", preset: "last24h", from: null, to: null });
    expect(decodeFilter("date", ["..2030-03-01"])).toEqual({ kind: "date", preset: null, from: null, to: "2030-03-01" });
  });

  it("ignores malformed values, unknown columns and unknown sort keys", () => {
    const q = new URLSearchParams("tri.sort=-bogus,sev,sev,-title&tri.sev=abc..&tri.last=yesterday&tri.bumped=maybe&tri.zzz=1&tri.title=%20%20");
    expect(parseTableState(q, "tri", KINDS)).toEqual({ sort: [{ id: "sev", desc: false }, { id: "title", desc: true }], filters: {} });
    expect(decodeFilter("numeric", [".."])).toBeNull();
    expect(decodeFilter("numeric", ["5"])).toBeNull();
    expect(decodeFilter("date", ["2030-2-1.."])).toBeNull();
    expect(decodeFilter("categorical", [])).toBeNull();
  });

  it("only sorts by sortable columns when a list is given", () => {
    expect(parseTableState(new URLSearchParams("t1.sort=a,b"), "t1", { a: "text", b: "text" }, ["b"]).sort).toEqual([{ id: "b", desc: false }]);
  });

  it("table parameters are sticky across in-app navigation, alongside search and t", () => {
    expect(isTableParam("tri.sev")).toBe(true);
    expect(isTableParam("rv-late-junior.sort")).toBe(true);
    expect(isTableParam("search")).toBe(false);
    expect(isTableParam("ac")).toBe(false);
    const to = withSticky("/papers/4?ac=x%40example.org", "?search=5&tri.sort=-sev&tri.acs=A&tri.acs=B");
    const u = new URLSearchParams(to.split("?")[1]);
    expect(u.get("ac")).toBe("x@example.org");
    expect(u.get("search")).toBe("5");
    expect(u.get("tri.sort")).toBe("-sev");
    expect(u.getAll("tri.acs")).toEqual(["A", "B"]);
    // A target that sets a table's parameter keeps its own value.
    expect(new URLSearchParams(withSticky("/?tri.sort=pid", "?tri.sort=-sev").split("?")[1]).getAll("tri.sort")).toEqual(["pid"]);
  });
});

describe("conference-zone days", () => {
  it("finds local midnight across DST changes", () => {
    expect(zonedDayStart("2030-01-15", "America/New_York")).toBe(Date.UTC(2030, 0, 15, 5));
    expect(zonedDayStart("2030-07-15", "America/New_York")).toBe(Date.UTC(2030, 6, 15, 4));
    // DST starts 2030-03-10 at 02:00: that day's midnight is still EST.
    expect(zonedDayStart("2030-03-10", "America/New_York")).toBe(Date.UTC(2030, 2, 10, 5));
    expect(zonedDayStart("2030-03-11", "America/New_York")).toBe(Date.UTC(2030, 2, 11, 4));
    expect(zonedDayStart("2030-02-26", "UTC")).toBe(Date.UTC(2030, 1, 26));
    expect(zonedDayStart("2030-02-26", "Asia/Kolkata")).toBe(Date.UTC(2030, 1, 25, 18, 30));
  });
  it("formats and steps days", () => {
    expect(zonedDay(NOW, "America/New_York")).toBe("2030-02-26");
    expect(zonedDay(Date.UTC(2030, 1, 27, 3), "America/New_York")).toBe("2030-02-26");
    expect(addDays("2030-02-28", 1)).toBe("2030-03-01");
    expect(addDays("2030-03-01", -1)).toBe("2030-02-28");
  });
  it("the current phase began at the latest boundary not after now", () => {
    const phases = { reviewDue: 10, responseOpen: 20, responseClose: null, discussionOpen: 30, discussionClose: 40 };
    expect(phaseStartOf(phases, 35)).toBe(30);
    expect(phaseStartOf(phases, 30)).toBe(30);
    expect(phaseStartOf(phases, 5)).toBeNull();
  });
});

describe("popover placement", () => {
  const view = { width: 1000, height: 700 };
  it("goes below the anchor, clamped to the viewport", () => {
    expect(placeBelow({ top: 100, bottom: 120, left: 50 }, { width: 300, height: 200 }, view)).toEqual({ top: 122, left: 50, maxHeight: 572 });
    expect(placeBelow({ top: 100, bottom: 120, left: 900 }, { width: 300, height: 200 }, view).left).toBe(692);
  });
  it("flips above when there is more room there", () => {
    const p = placeBelow({ top: 600, bottom: 620, left: 10 }, { width: 300, height: 300 }, view);
    expect(p.top).toBe(298);
    expect(p.maxHeight).toBe(592);
  });
});
