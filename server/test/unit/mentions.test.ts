import { describe, expect, it } from "vitest";
import { mentionRoster, parseMentions, textHash, wordCount } from "../../src/sync/text.js";

const roster = mentionRoster([
  { name: "Jane Doe", email: "jane.doe@example.org" },
  { name: "Jane Roe", email: "jroe@example.org" },
  { name: "Bob Stone", email: "bob@example.org" },
  { name: "José Álvarez", email: "jalvarez@example.org" },
  { name: "Mary Ann Lee", email: "mlee@example.org" },
  { name: "J. R. Hartley", email: "jrh@example.org" },
  { name: "Kim Park-Lee", email: "kpl@example.org" },
  { name: "noname@example.org", email: "noname@example.org" },
  { name: "", email: "Mixed.Case@Example.org" },
]);
const p = (t: string) => parseMentions(t, roster);

describe("parseMentions: emails", () => {
  it("matches a roster email, case-insensitively", () => {
    expect(p("@bob@example.org what do you think?")).toEqual(["bob@example.org"]);
    expect(p("ping @BOB@EXAMPLE.ORG")).toEqual(["bob@example.org"]);
    expect(p("cc @mixed.case@example.org")).toEqual(["mixed.case@example.org"]);
  });

  it("strips trailing sentence punctuation", () => {
    expect(p("Thanks @bob@example.org.")).toEqual(["bob@example.org"]);
    expect(p("(@bob@example.org)")).toEqual(["bob@example.org"]);
    expect(p("@bob@example.org, @jroe@example.org; done")).toEqual(["bob@example.org", "jroe@example.org"]);
  });

  it("ignores emails that are not on the roster", () => {
    expect(p("@stranger@example.org hello")).toEqual([]);
  });

  it("ignores emails without a leading @ mention", () => {
    expect(p("write to bob@example.org")).toEqual([]);
  });
});

describe("parseMentions: names", () => {
  it("full name", () => {
    expect(p("@Jane Doe can you comment?")).toEqual(["jane.doe@example.org"]);
    expect(p("@Bob Stone")).toEqual(["bob@example.org"]);
  });

  it("unique first name or family name alone", () => {
    expect(p("@Bob, any thoughts?")).toEqual(["bob@example.org"]);
    expect(p("@Stone, any thoughts?")).toEqual(["bob@example.org"]);
    expect(p("@Doe please respond")).toEqual(["jane.doe@example.org"]);
  });

  it("ambiguous first name needs the family name", () => {
    expect(p("@Jane what do you think?")).toEqual([]);
    expect(p("@Jane Roe what do you think?")).toEqual(["jroe@example.org"]);
  });

  it("is case- and accent-insensitive", () => {
    expect(p("@jose alvarez thoughts?")).toEqual(["jalvarez@example.org"]);
    expect(p("@JOSÉ ÁLVAREZ thoughts?")).toEqual(["jalvarez@example.org"]);
  });

  it("multi-word given names, and skipping to the family name", () => {
    expect(p("@Mary Ann Lee agreed")).toEqual(["mlee@example.org"]);
    expect(p("@Mary Lee agreed")).toEqual(["mlee@example.org"]);
    expect(p("@Lee agreed")).toEqual(["mlee@example.org"]);
  });

  it("initials with periods", () => {
    expect(p("@J. R. Hartley: see above")).toEqual(["jrh@example.org"]);
    expect(p("@Hartley see above")).toEqual(["jrh@example.org"]);
  });

  it("hyphenated names", () => {
    expect(p("@Kim Park-Lee, please")).toEqual(["kpl@example.org"]);
    expect(p("@Park-Lee please")).toEqual(["kpl@example.org"]);
  });

  it("trailing punctuation ends a mention", () => {
    for (const end of [",", ".", ":", ";", "?", "!", ")", "'s view", "’s view", " -- ok"]) {
      expect(p(`(@Bob Stone${end}`), end).toEqual(["bob@example.org"]);
    }
  });

  it("a name glued to more letters is not a mention", () => {
    expect(p("@Bobby, hi")).toEqual([]);
    expect(p("@Stoner hi")).toEqual([]);
  });

  it("unknown names are ignored", () => {
    expect(p("@Nobody Here what do you think?")).toEqual([]);
    expect(p("@ alone")).toEqual([]);
    expect(p("trailing @")).toEqual([]);
  });

  it("email local part", () => {
    expect(p("@jroe what do you think?")).toEqual(["jroe@example.org"]);
    expect(p("@kpl!")).toEqual(["kpl@example.org"]);
  });

  it("people without a display name match only by email / local part", () => {
    expect(p("@noname hi")).toEqual(["noname@example.org"]);
    expect(p("@noname@example.org hi")).toEqual(["noname@example.org"]);
  });
});

describe("parseMentions: context", () => {
  it("multiple mentions, in order, de-duplicated", () => {
    expect(p("@Bob Stone and @Jane Doe, then @Bob again; also @jroe@example.org")).toEqual([
      "bob@example.org",
      "jane.doe@example.org",
      "jroe@example.org",
    ]);
  });

  it("requires a word boundary before @", () => {
    expect(p("foo@Bob Stone")).toEqual([]);
    expect(p("x@bob@example.org")).toEqual([]);
  });

  it("allows ([{-+,;/ and dashes before @", () => {
    expect(p("[@Bob]")).toEqual(["bob@example.org"]);
    expect(p("ping,@Bob")).toEqual(["bob@example.org"]);
    expect(p("ping/@Bob")).toEqual(["bob@example.org"]);
    expect(p("ok—@Bob")).toEqual(["bob@example.org"]);
  });

  it("mentions across a line break", () => {
    expect(p("Thoughts?\n@Bob Stone\nthanks")).toEqual(["bob@example.org"]);
    expect(p("@Jane\nDoe")).toEqual(["jane.doe@example.org"]);
  });

  it("empty text and empty roster", () => {
    expect(p("")).toEqual([]);
    expect(parseMentions("@Bob Stone", mentionRoster([]))).toEqual([]);
  });
});

describe("wordCount", () => {
  it("counts tokens with letters or digits", () => {
    expect(wordCount("The baselines are weak.")).toBe(4);
    expect(wordCount("  a  -- b\n\nc 42 ")).toBe(4);
    expect(wordCount("")).toBe(0);
    expect(wordCount(null)).toBe(0);
    expect(wordCount("état de l’art")).toBe(3);
  });
});

describe("textHash", () => {
  it("is stable and content-sensitive", () => {
    expect(textHash("a")).toBe(textHash("a"));
    expect(textHash("a")).not.toBe(textHash("b"));
  });
});
