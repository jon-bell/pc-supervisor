import { describe, expect, it } from "vitest";
import { CsvError, parseCsv, parseCsvLines, parseCsvRecords } from "../../src/hotcrp/csv.js";

describe("parseCsv", () => {
  it("parses plain rows with LF, CRLF, and CR", () => {
    expect(parseCsv("a,b\n1,2\r\n3,4\r5,6")).toEqual([["a", "b"], ["1", "2"], ["3", "4"], ["5", "6"]]);
  });

  it("handles quotes, escaped quotes, commas and newlines inside quotes", () => {
    expect(parseCsv('x,"he said ""hi""","a,b","line1\nline2"\n')).toEqual([
      ["x", 'he said "hi"', "a,b", "line1\nline2"],
    ]);
  });

  it("keeps empty fields and skips blank lines", () => {
    expect(parseCsv("a,,c\n\n,\n\"\"\n")).toEqual([["a", "", "c"], ["", ""], [""]]);
  });

  it("strips a BOM", () => {
    expect(parseCsv("﻿a,b\n")).toEqual([["a", "b"]]);
  });

  it.each([
    ['"unterminated', /unterminated/],
    ['ab"c', /quote inside/],
    ['"a"b', /after a closing quote/],
  ])("rejects %j", (text, re) => {
    expect(() => parseCsv(text)).toThrow(CsvError);
    expect(() => parseCsv(text)).toThrow(re);
  });
});

describe("parseCsvRecords", () => {
  it("maps headers and tolerates short rows (HotCRP pcassignments shape)", () => {
    const text = 'paper,action,email,title\n1,clearreview,"#pc",Smoke Paper\n1,primaryreview,r1@example.org\n';
    expect(parseCsvRecords(text)).toEqual([
      { paper: "1", action: "clearreview", email: "#pc", title: "Smoke Paper" },
      { paper: "1", action: "primaryreview", email: "r1@example.org" },
    ]);
  });

  it("rejects rows longer than the header", () => {
    expect(() => parseCsvRecords("a\n1,2\n")).toThrow(/row 2/);
  });

  it("returns nothing for empty input", () => {
    expect(parseCsvRecords("")).toEqual([]);
  });
});

describe("parseCsvLines", () => {
  it("keeps each row's starting line, across blank lines and quoted newlines", () => {
    expect(parseCsvLines('h\n\na\n"b\nc"\r\nd\n')).toEqual([
      { line: 1, cells: ["h"] },
      { line: 3, cells: ["a"] },
      { line: 4, cells: ["b\nc"] },
      { line: 6, cells: ["d"] },
    ]);
  });

  it("reports an unterminated quote at the line where it opened", () => {
    expect(() => parseCsvLines('a\n"b\nc\nd\n')).toThrow(/^line 2: unterminated/);
  });
});
