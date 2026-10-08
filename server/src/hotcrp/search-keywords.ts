// HotCRP's search keywords and operators, for the filter box's completions.
//
// Derived from hotcrp@60f693f88b9a0ef9e34b11af957a513f1c122690:
//   - etc/searchkeywords.json (every keyword and its aliases; the regex-
//     matched ones: [c|i|p]re, pri/sec/ext/meta, cmt/aucmt/anycmt, response,
//     review-field and option abbreviations),
//   - src/searchoperatorset.php (operators),
//   - src/help/h_keywords.php (the examples behind each hint).
// Review-field and submission-option keywords (OveMer:, opt:, …) come from
// the instance (search-completions.ts), not from here.
//
// `values` names where the completions after the colon come from:
//   "pc"   = PC members (email; name shown), plus `fixed`;
//   "tag"  = paper tags;
//   "dec" / "round" / "opt" / "has" / "show" / "status" = instance values;
//   undefined = only `fixed` (or free text).
// Every `text` + fixed value is a valid search at that ref (checked against
// the harness in server/test/integration/search-parity.test.ts).

export interface SearchKeyword {
  /** What is inserted, e.g. "re:". */
  text: string;
  hint: string;
  /** Other spellings HotCRP accepts (matched when typing, not inserted). */
  aliases?: readonly string[];
  values?: "pc" | "tag" | "dec" | "round" | "opt" | "has" | "show" | "status";
  /** Values that are always valid after the colon. */
  fixed?: readonly string[];
}

export interface SearchOperator {
  text: string;
  hint: string;
}

const REVIEW_FIXED = ["any", "none", "me", "complete", "incomplete", "inprogress", "primary", "secondary", "external", "meta", "myreq"];
const ANY_NONE = ["any", "none"];

export const SEARCH_KEYWORDS: readonly SearchKeyword[] = [
  // Reviews
  { text: "re:", hint: "has a review by (email, name, count, round, type)", aliases: ["r", "rev", "review"], values: "pc", fixed: REVIEW_FIXED },
  { text: "cre:", hint: "has a complete review by", aliases: ["crev", "creview"], values: "pc", fixed: ["any", "none", "me"] },
  { text: "ire:", hint: "has an incomplete review by", aliases: ["irev", "ireview"], values: "pc", fixed: ["any", "none", "me"] },
  { text: "pre:", hint: "has an in-progress review by", aliases: ["prev", "preview"], values: "pc", fixed: ["any", "none", "me"] },
  { text: "pri:", hint: "primary reviewer", aliases: ["primary"], values: "pc", fixed: ["any", "none", "me"] },
  { text: "sec:", hint: "secondary reviewer", aliases: ["secondary"], values: "pc", fixed: ["any", "none", "me"] },
  { text: "ext:", hint: "external reviewer", aliases: ["external"], values: "pc", fixed: ["any", "none"] },
  { text: "meta:", hint: "metareviewer", values: "pc", fixed: ["any", "none", "me"] },
  // round:any/none only parse when the instance has rounds; HotCRP offers them then.
  { text: "round:", hint: "review round", values: "round" },
  { text: "rate:", hint: "review rating (good, bad, …)", aliases: ["rating"], fixed: ["good", "bad", "any", "none"] },
  { text: "pref:", hint: "review preference", aliases: ["revpref", "preference"], values: "pc" },
  { text: "retoken:", hint: "review token", aliases: ["token", "rtoken", "reviewtoken"] },
  { text: "proposal:", hint: "proposed review by", aliases: ["proposed"], values: "pc", fixed: ["any", "none"] },
  // Roles
  { text: "lead:", hint: "discussion lead", values: "pc", fixed: ["any", "none", "me"] },
  { text: "shepherd:", hint: "shepherd", aliases: ["shep"], values: "pc", fixed: ["any", "none", "me"] },
  { text: "manager:", hint: "paper administrator", aliases: ["admin", "administrator"], values: "pc", fixed: ["any", "none", "me"] },
  { text: "conflict:", hint: "conflicted with (PC member, pc, me)", aliases: ["conf"], values: "pc", fixed: ["me", "pc"] },
  { text: "pcconf:", hint: "PC conflict with", aliases: ["pcconflict"], values: "pc", fixed: ["any", "none"] },
  { text: "reconflict:", hint: "conflicts with a reviewer's papers", aliases: ["reconf"] },
  // Comments
  { text: "cmt:", hint: "comment by, or count (cmt:>=3)", aliases: ["comment"], values: "pc", fixed: ["any", "none"] },
  { text: "aucmt:", hint: "author-visible comment", aliases: ["aucomment"], fixed: ["any", "none"] },
  { text: "anycmt:", hint: "any comment, including drafts", aliases: ["anycomment"], fixed: ["any", "none"] },
  // Paper fields
  { text: "ti:", hint: "title contains", aliases: ["title"] },
  { text: "ab:", hint: "abstract contains", aliases: ["abstract"] },
  { text: "au:", hint: "author name, email or affiliation", aliases: ["author"] },
  { text: "co:", hint: "collaborators contain", aliases: ["collab", "collaborators"] },
  { text: "topic:", hint: "topic", aliases: ["topics"], fixed: ANY_NONE },
  { text: "opt:", hint: "submission field", aliases: ["option"], values: "opt" },
  { text: "pages:", hint: "page count (pages:<10)", aliases: ["pagecount"] },
  { text: "has:", hint: "has a field (has:lead, has:final, …)", values: "has" },
  // Status
  { text: "dec:", hint: "decision", aliases: ["decision"], values: "dec", fixed: ["any", "none", "yes", "no"] },
  { text: "status:", hint: "submission status", aliases: ["is"], values: "status", fixed: ["submitted", "withdrawn", "unsubmitted", "accepted", "rejected", "undecided"] },
  { text: "in:", hint: "collection (in:all, in:accepted)", fixed: ["all", "s", "accepted", "undecided", "active", "unsub", "r", "lead", "admin", "viewable"] },
  { text: "phase:", hint: "submission phase", fixed: ["final", "review"] },
  { text: "sclass:", hint: "submission class", aliases: ["subclass"] },
  { text: "after:", hint: "submitted after a date" },
  { text: "before:", hint: "submitted before a date" },
  // Tags
  { text: "#", hint: "tagged", values: "tag" },
  { text: "tag:", hint: "tagged", aliases: ["hashtag"], values: "tag" },
  { text: "notag:", hint: "not tagged", values: "tag" },
  { text: "order:", hint: "tagged, sorted by tag value", values: "tag" },
  { text: "rorder:", hint: "tagged, reverse tag order", aliases: ["revorder"], values: "tag" },
  { text: "color:", hint: "tag color", fixed: ["any", "none"] },
  { text: "style:", hint: "tag style", fixed: ["any", "none"] },
  { text: "badge:", hint: "tag badge", fixed: ["any", "none"] },
  { text: "emoji:", hint: "tag emoji", fixed: ["any", "none"] },
  // Formulas and saved searches
  { text: "formula:", hint: "formula is true (formula:var(OveMer)>0.5)", aliases: ["f"] },
  { text: "ss:", hint: "saved search", aliases: ["search"] },
  // Display (no effect on which papers match)
  { text: "show:", hint: "show a column (no effect on matches)", aliases: ["view"], values: "show" },
  { text: "hide:", hint: "hide a column (no effect on matches)", values: "show" },
  { text: "sort:", hint: "sort order (no effect on matches)", values: "show" },
  { text: "edit:", hint: "edit a tag inline (no effect on matches)", values: "tag" },
  { text: "HEADING:", hint: "group heading (no effect on matches)", aliases: ["LEGEND", "legend", "heading"] },
];

export const SEARCH_OPERATORS: readonly SearchOperator[] = [
  { text: "OR", hint: "either side matches" },
  { text: "AND", hint: "both sides match (same as a space)" },
  { text: "NOT", hint: "doesn't match (same as -)" },
  { text: "XOR", hint: "exactly one side matches" },
  { text: "THEN", hint: "groups: left papers, then right papers" },
  { text: "HIGHLIGHT", hint: "left papers, highlighting right matches" },
];
