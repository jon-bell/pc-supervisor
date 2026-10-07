// Spec §7 wording: no user-visible string may judge people. This scans every
// UI string source (web/src, and the server's rules and API, which produce the
// reason strings, outlier details and error messages) for "disengaged",
// "absent" and "lazy" (any case, any inflection).
//
// What counts as a string: string and template literals and JSX text, found
// with the TypeScript parser, so comments and identifiers are ignored. Rule
// NAMES such as AC_ABSENT are identifiers even when quoted ("AC_ABSENT"), so an
// all-caps SNAKE_CASE literal is allowed; their labels (format.ts RULE_LABELS)
// are scanned like any other string.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SOURCES = ["web/src", "server/src/rules", "server/src/server", "server/src/modules"];
const BANNED = /disengag|absent|lazy|lazi/i;
const RULE_NAME = /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/;

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (/\.(ts|tsx)$/.test(name) && !name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

/** Every string a user could see in this source: literals, template parts, JSX text. */
export function uiStrings(fileName: string, code: string): { text: string; line: number }[] {
  const sf = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: { text: string; line: number }[] = [];
  const add = (n: ts.Node, text: string) => out.push({ text, line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1 });
  const visit = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) return;
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      if (!RULE_NAME.test(n.text)) add(n, n.text);
    } else if (ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) {
      add(n, n.text);
    } else if (ts.isJsxText(n)) {
      if (n.text.trim()) add(n, n.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

function violations(fileName: string, code: string): string[] {
  return uiStrings(fileName, code)
    .filter((s) => BANNED.test(s.text))
    .map((s) => `${fileName}:${s.line}: ${JSON.stringify(s.text.trim())}`);
}

describe("wording (spec §7)", () => {
  it("the scanner finds banned words in literals, templates and JSX, and allows rule names and comments", () => {
    const code = [
      "// a comment about absent reviewers is fine",
      'const RULES = { AC_ABSENT: "No AC comment yet" };',
      'const a = "AC_ABSENT";',
      'const b = "reviewer absent";',
      "const c = `${n} Disengaged reviewers`;",
      "const d = <p title='lazy'>x</p>;",
      "const e = <p>Laziness</p>;",
      "const acAbsent = 1;",
    ].join("\n");
    expect(violations("t.tsx", code)).toEqual([
      't.tsx:4: "reviewer absent"',
      't.tsx:5: "Disengaged reviewers"',
      't.tsx:6: "lazy"',
      't.tsx:7: "Laziness"',
    ]);
  });

  it("no UI string in web/src or the server's reason strings says disengaged, absent or lazy", () => {
    const all = SOURCES.flatMap((d) => files(join(ROOT, d)));
    // Guard against scanning nothing (a moved directory would pass vacuously).
    expect(all.some((f) => f.endsWith("format.ts"))).toBe(true);
    expect(all.some((f) => f.endsWith("rules.ts"))).toBe(true);
    expect(all.some((f) => f.endsWith("reviewer-metrics.ts"))).toBe(true);
    const bad = all.flatMap((f) => violations(relative(ROOT, f), readFileSync(f, "utf8")));
    expect(bad).toEqual([]);
  });

  it("the AC_ABSENT chip label says what HotCRP shows", () => {
    const format = readFileSync(join(ROOT, "web/src/format.ts"), "utf8");
    expect(format).toMatch(/AC_ABSENT: "No AC comment yet"/);
    expect(format).toMatch(/SILENT_DISCUSSION: "No comments yet"/);
  });
});
