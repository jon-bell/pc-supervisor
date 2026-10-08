// Review ratings (spec §1): HotCRP's multiset encoding, the stored counts,
// the Zod schema, and migration 6's conversion of the old flag-list column.
import Database from "better-sqlite3-multiple-ciphers";
import { describe, expect, it } from "vitest";
import { RatingValueSchema, ReviewSchema, RatingSettingsSchema } from "../../src/hotcrp/schemas.js";
import { countRatings, formatRatings, parseRatings, ratingsEnabledFor, ratingsJson, ratingTotal, NEGATIVE_FLAGS } from "../../src/ratings.js";
import { MIGRATIONS } from "../../src/store/migrations.js";

describe("ratings encoding", () => {
  it("a sorted multiset counts raters per flag; a bare string is one flag; absent is none", () => {
    expect(countRatings(["short", "short", "vague"])).toEqual({ short: 2, vague: 1 });
    expect(countRatings("disrespectful")).toEqual({ disrespectful: 1 });
    expect(countRatings(undefined)).toEqual({});
    expect(countRatings("none")).toEqual({});
  });
  it("stores canonical JSON (vocabulary order), so equal ratings compare equal", () => {
    expect(ratingsJson({ vague: 1, short: 2 })).toBe('{"short":2,"vague":1}');
    expect(ratingsJson(countRatings(["vague", "short", "short"]))).toBe(ratingsJson({ short: 2, vague: 1 }));
    expect(ratingsJson({ good: 0 })).toBe("{}");
  });
  it("parses the counts column and, for safety, the old list form", () => {
    expect(parseRatings('{"vague":1,"short":2}')).toEqual({ short: 2, vague: 1 });
    expect(parseRatings('["short","short"]')).toEqual({ short: 2 });
    expect(parseRatings('{"bogus":3,"short":-1,"wrong":1}')).toEqual({ wrong: 1 });
    expect(parseRatings("not json")).toEqual({});
  });
  it("formats counts as the reasons quote them", () => {
    expect(formatRatings({ vague: 1, short: 2 })).toBe("2× short, 1× vague");
    expect(formatRatings({ good: 2, wrong: 1 }, NEGATIVE_FLAGS)).toBe("1× wrong");
    expect(ratingTotal({ good: 2, wrong: 1, short: 3 }, NEGATIVE_FLAGS)).toBe(4);
  });
  it("ratings are on unless the instance says review_rating = no", () => {
    expect([ratingsEnabledFor("pc"), ratingsEnabledFor("all"), ratingsEnabledFor(null), ratingsEnabledFor("no")]).toEqual([true, true, true, false]);
  });
});

describe("schemas", () => {
  const review = { object: "review", pid: 1, rid: 2, status: "complete" };
  it("accepts the verified shapes", () => {
    expect(ReviewSchema.parse({ ...review, ratings: ["short", "short", "vague"] }).ratings).toEqual(["short", "short", "vague"]);
    expect(ReviewSchema.parse({ ...review, ratings: "wrong" }).ratings).toBe("wrong");
    expect(ReviewSchema.parse(review).ratings).toBeUndefined();
    expect(RatingValueSchema.parse("none")).toBe("none");
    expect(RatingSettingsSchema.parse({ ok: true, settings: { review_rating: "pc", review_rating_visibility: "limited" } }).settings.review_rating).toBe("pc");
  });
  it("rejects a flag outside HotCRP's vocabulary instead of hiding it", () => {
    expect(ReviewSchema.safeParse({ ...review, ratings: ["short", "sloppy"] }).success).toBe(false);
    expect(RatingSettingsSchema.safeParse({ ok: true, settings: { review_rating: "maybe", review_rating_visibility: "limited" } }).success).toBe(false);
  });
});

describe("migration 6 (ratings)", () => {
  it("converts flag lists to counts and adds rating_change", () => {
    const db = new Database(":memory:");
    for (const m of MIGRATIONS.slice(0, 5)) db.exec(m);
    const ins = db.prepare("insert into review (rid, pid, email, status, first_seen_at, ratings) values (?, 1, 'a@example.org', 'complete', 0, ?)");
    ins.run(1, '["short","short","vague"]');
    ins.run(2, "[]");
    ins.run(3, "garbage");
    db.exec(MIGRATIONS[5]!);
    const rows = db.prepare("select rid, ratings from review order by rid").all() as { rid: number; ratings: string }[];
    expect(rows.map((r) => [r.rid, parseRatings(r.ratings)])).toEqual([
      [1, { short: 2, vague: 1 }],
      [2, {}],
      [3, {}],
    ]);
    expect(rows[2]!.ratings).toBe("{}");
    db.prepare("insert into rating_change (rid, seen_at, before, after) values (1, 5, null, '{}')").run();
    expect(db.prepare("select count(*) as n from rating_change").get()).toEqual({ n: 1 });
    db.close();
  });
});
