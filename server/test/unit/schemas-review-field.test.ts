import { describe, expect, it } from "vitest";
import { reviewField, reviewScore, type Review } from "../../src/hotcrp/schemas.js";

// Values as ReviewField::unparse_json emits them, per field type.
const r = {
  object: "review",
  pid: 1,
  rid: 7,
  OveMer: 3,
  Letter: "B",
  NoEntry: false,
  Missing: null,
  PapSum: "text",
  IFolIns: true,
  Topics: ["A", 2],
  Weird: { a: 1 },
} as unknown as Review;

describe("reviewField", () => {
  it("accepts every type HotCRP sends: number, string, boolean, symbol list, null", () => {
    expect(reviewField(r, "OveMer")).toBe(3);
    expect(reviewField(r, "PapSum")).toBe("text");
    expect(reviewField(r, "IFolIns")).toBe(true);
    expect(reviewField(r, "NoEntry")).toBe(false);
    expect(reviewField(r, "Topics")).toEqual(["A", 2]);
    expect(reviewField(r, "Missing")).toBeNull();
    expect(reviewField(r, "Absent")).toBeUndefined();
  });

  it("throws on anything else", () => {
    expect(() => reviewField(r, "Weird")).toThrow("review 7: field Weird has unexpected type object");
  });
});

describe("reviewScore", () => {
  it("returns the symbol; false (no entry) becomes null, never 0", () => {
    expect(reviewScore(r, "OveMer")).toBe(3);
    expect(reviewScore(r, "Letter")).toBe("B");
    expect(reviewScore(r, "NoEntry")).toBeNull();
    expect(reviewScore(r, "Missing")).toBeNull();
    expect(reviewScore(r, "Absent")).toBeUndefined();
  });

  it("throws on non-score values", () => {
    expect(() => reviewScore(r, "IFolIns")).toThrow("review 7: score field IFolIns has unexpected type boolean");
    expect(() => reviewScore(r, "Topics")).toThrow("review 7: score field Topics has unexpected type array");
  });
});
