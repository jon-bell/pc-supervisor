// Score colour mapping (scores.tsx, HotCRP's scheme_value_class), outlier
// marks (outliers.tsx), reason levels and severity steps. Synthetic values only.
import { describe, expect, it } from "vitest";
import { byWeight, levelOf } from "../../src/components/Chip";
import { sevStep } from "../../src/components/Severity";
import { cohort, quantile, type MetricSpec } from "../../src/outliers";
import { scaleSize, scoreClass } from "../../src/scores";

describe("scoreClass (HotCRP scheme mapping)", () => {
  it("spreads an n-value field over the nine sv steps", () => {
    expect([1, 2, 3, 4, 5].map((v) => scoreClass(v, 5))).toEqual(["sv-sv1", "sv-sv3", "sv-sv5", "sv-sv7", "sv-sv9"]);
    expect([1, 4].map((v) => scoreClass(v, 4))).toEqual(["sv-sv1", "sv-sv9"]);
  });
  it("flips reversed schemes onto their base family", () => {
    expect(scoreClass(1, 5, "svr")).toBe("sv-sv9");
    expect(scoreClass(5, 5, "pubu")).toBe("sv-bupu1");
    expect(scoreClass(1, 5, "viridis")).toBe("sv-viridis1");
  });
  it("has no class for a missing value, neutral for none, and falls back to sv for unknown schemes", () => {
    expect(scoreClass(null, 5)).toBe("");
    expect(scoreClass(0, 5)).toBe("");
    expect(scoreClass(3, 5, "none")).toBe("sv-none");
    expect(scoreClass(5, 5, "nonsense")).toBe("sv-sv9");
    expect(scoreClass(5, 5, "turbo")).toBe("sv-sv9");
  });
  it("sizes the scale from the form, else from the values seen", () => {
    expect(scaleSize({ uid: "OveMer", name: "Overall merit", labels: ["a", "b", "c", "d"], scheme: "sv" })).toBe(4);
    expect(scaleSize(null, [1, 3])).toBe(3);
    expect(scaleSize(null, [])).toBe(2);
  });
});

interface Row {
  name: string;
  comments: number;
  load: number;
  days: number | null;
}
const rows = (xs: [string, number, number?, (number | null)?][]): Row[] => xs.map(([name, comments, load = 15, days = 1]) => ({ name, comments, load, days }));
const comments: MetricSpec<Row> = { noun: "comments", cohort: "AC", direction: "higher-better", value: (r) => r.comments, perPaper: (r) => r.load };
const days: MetricSpec<Row> = { noun: "days", cohort: "AC", direction: "lower-better", value: (r) => r.days, minGap: 0.5 };

describe("outlier marks", () => {
  it("quantile interpolates", () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([5, 7, 14, 15, 16, 17, 21, 22, 24, 24], 0.25)).toBe(14.25);
  });
  it("marks only the concerning side, beyond the quartile and far enough from the median", () => {
    const data = rows([["Alba", 16], ["Bram", 15], ["Cleo", 22], ["Dov", 21], ["Edda", 5], ["Fitz", 24], ["Gita", 24], ["Hale", 7], ["Ines", 17], ["Jory", 14]]);
    const c = cohort(data, comments);
    const marked = data.filter((r) => c.mark(r)).map((r) => r.name);
    expect(marked).toEqual(["Edda", "Hale"]);
    expect(c.mark(data[4]!)!.text).toBe("5 comments; AC median 16.5; below the 25th percentile of ACs");
    // High values on a more-is-better metric are never marked.
    expect(c.mark(data[5]!)).toBeNull();
  });
  it("compares per paper when loads differ", () => {
    const data = rows([["A", 10, 10], ["B", 10, 10], ["C", 2, 2], ["D", 1, 10]]);
    const c = cohort(data, comments);
    expect(c.mark(data[2]!)).toBeNull(); // 1 per paper, like A and B
    expect(c.mark(data[3]!)!.text).toMatch(/^1 comments \(0\.1 per paper\); AC median 1 per paper/);
  });
  it("marks high values of a less-is-better metric, respecting minGap", () => {
    const data = rows([["A", 0, 15, 1], ["B", 0, 15, 1.2], ["C", 0, 15, 1.1], ["D", 0, 15, 1.4], ["E", 0, 15, 4]]);
    const c = cohort(data, days);
    expect(data.filter((r) => c.mark(r)).map((r) => r.name)).toEqual(["E"]);
    expect(c.mark(data[4]!)!.side).toBe("high");
  });
  it("marks nothing in a constant column or a cohort under three", () => {
    const same = cohort(rows([["A", 3], ["B", 3], ["C", 3]]), comments);
    expect(same.constant).toBe(true);
    const two = rows([["A", 0], ["B", 30]]);
    expect(two.map((r) => cohort(two, comments).mark(r))).toEqual([null, null]);
  });
});

describe("reason levels and severity steps", () => {
  it("maps weights to three levels and sorts heaviest first, stably", () => {
    expect([0, 1, 2, 3, 4].map(levelOf)).toEqual([1, 1, 2, 3, 3]);
    const rs = [
      { rule: "A", weight: 1, reason: "" },
      { rule: "B", weight: 3, reason: "" },
      { rule: "C", weight: 1, reason: "" },
      { rule: "D", weight: 3, reason: "" },
    ];
    expect(byWeight(rs).map((r) => r.rule)).toEqual(["B", "D", "A", "C"]);
  });
  it("steps severity relative to the largest", () => {
    expect([0, 1, 5, 10].map((s) => sevStep(s, 10))).toEqual([0, 1, 3, 5]);
    expect(sevStep(3, 0)).toBe(0);
  });
});
