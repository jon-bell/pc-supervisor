// Nudge-comment drafts (PLAN M8, spec §6). The app only drafts: the chair
// copies the text and posts it in HotCRP themselves; nothing here writes.
//
// Who is @mentioned (by roster name, the form HotCRP's comment editor uses):
//   - MISSING_REVIEWS fired: the reviewers whose reviews aren't submitted;
//   - otherwise, if a discussion rule fired (SPLIT, UNRESOLVED_SPLIT,
//     SILENT_DISCUSSION, GONE_QUIET, CHAMPION_MISSING, RESPONSE_UNADDRESSED,
//     DEADLINE_NO_CONSENSUS) or nothing fired: the submitted reviewers with
//     no comment since DISCUSSION_OPEN (all submitted reviewers if every one
//     has commented); plus the ACs when AC_ABSENT fired;
//   - otherwise (only AC_ABSENT, LOW_EXPERTISE, THIN_REVIEWS): the ACs, or
//     the reviewers if the paper has no AC.
// The fired rules' reason strings go in verbatim, so the numbers match the
// dashboard. Wording follows spec §7: it says what HotCRP shows and asks
// politely; it never characterizes a person.

import type { RuleName } from "../config.js";
import type { RuleContext } from "../rules/context.js";
import type { PaperResult } from "../rules/evaluate.js";
import { isSubmitted, type PaperFacts } from "../rules/facts.js";
import type { PersonView } from "../rules/model.js";

export type NudgeAudience = "unsubmitted-reviewers" | "reviewers-without-comments" | "reviewers" | "acs";

export interface NudgeDraft {
  pid: number;
  audience: NudgeAudience;
  mentions: { email: string; name: string }[];
  text: string;
}

const DISCUSSION_RULES: ReadonlySet<RuleName> = new Set([
  "SPLIT",
  "UNRESOLVED_SPLIT",
  "SILENT_DISCUSSION",
  "GONE_QUIET",
  "CHAMPION_MISSING",
  "RESPONSE_UNADDRESSED",
  "DEADLINE_NO_CONSENSUS",
]);

/** Short, neutral labels for the "where things stand" lines. */
const LINE_LABEL: Readonly<Record<RuleName, string>> = {
  MISSING_REVIEWS: "Reviews outstanding",
  SPLIT: "Scores are split",
  UNRESOLVED_SPLIT: "No score movement yet",
  SILENT_DISCUSSION: "No comments yet",
  GONE_QUIET: "No recent activity",
  AC_ABSENT: "No AC comment yet",
  CHAMPION_MISSING: "No comment yet from the highest score",
  LOW_EXPERTISE: "Expertise",
  THIN_REVIEWS: "Short reviews",
  RESPONSE_UNADDRESSED: "Author response not yet discussed",
  DEADLINE_NO_CONSENSUS: "Decision deadline",
};

const uniq = <T>(xs: readonly T[]) => [...new Set(xs)];

export function nudgeDraft(f: PaperFacts, result: PaperResult, people: ReadonlyMap<string, PersonView>, ctx: RuleContext): NudgeDraft {
  const fired = new Set(result.fired.map((r) => r.rule));
  const acs = [...f.acSet];
  const submitted = uniq(f.submitted.map((r) => r.email));
  const unsubmitted = uniq(f.reviewerReviews.filter((r) => !isSubmitted(r)).map((r) => r.email));
  const silent = submitted.filter((e) => !f.discussionCommenters.has(e));
  const discussion = fired.size === 0 || [...fired].some((r) => DISCUSSION_RULES.has(r));

  let audience: NudgeAudience;
  let emails: string[];
  let ask: string[];
  if (fired.has("MISSING_REVIEWS") && unsubmitted.length > 0) {
    audience = "unsubmitted-reviewers";
    emails = unsubmitted;
    ask = [
      "Could you submit your review when you can, or let us know if you need more time or can't complete it?",
      "The review deadline has passed, and the discussion is waiting on it.",
    ];
  } else if (discussion || acs.length === 0) {
    audience = silent.length > 0 ? "reviewers-without-comments" : "reviewers";
    emails = silent.length > 0 ? silent : submitted;
    const response = fired.has("RESPONSE_UNADDRESSED") ? " and the author response" : "";
    ask = [
      `When you have a moment, could you add a comment with your current view? It helps to say whether the other reviews${response} change your assessment, and what would change your score.`,
      "Even a few lines help the discussion move toward a decision.",
    ];
    if (fired.has("AC_ABSENT") && acs.length > 0) {
      const names = acs.map((e) => `@${nameOf(people, e)}`).join(" ");
      ask.push(`${names}, could you also post a short summary of where the discussion stands and what it needs to reach a decision?`);
      emails = uniq([...emails, ...acs]);
    }
  } else {
    audience = "acs";
    emails = acs;
    ask = [
      fired.has("AC_ABSENT")
        ? "Could you post a short comment on where this paper stands and what the discussion needs to reach a decision?"
        : "Could you take a look and say whether this paper needs another review, or a closer read of the existing ones?",
    ];
  }

  const mentions = emails.map((email) => ({ email, name: nameOf(people, email) }));
  const lines = result.fired.map((r) => `- ${LINE_LABEL[r.rule]}: ${r.reason}`);
  const opened = ctx.now >= ctx.phases.discussionOpen;
  const text = [
    mentions.map((m) => `@${m.name}`).join(" "),
    "",
    `Hello, and thank you for your work on this paper. A note from the PC chairs${opened ? ", to help the discussion along" : ""}.`,
    ...(lines.length > 0 ? ["", "Where things stand:", ...lines] : []),
    "",
    ...ask,
    "",
    "Thank you!",
  ]
    .join("\n")
    .replace(/^\n+/, "");
  return { pid: f.pid, audience, mentions, text };
}

function nameOf(people: ReadonlyMap<string, PersonView>, email: string): string {
  const n = people.get(email)?.name?.trim();
  return n ? n : email;
}
