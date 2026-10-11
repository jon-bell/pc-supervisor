// The heuristic comment classifier (spec §5e): the baseline behind the same
// interface as the model, used when PCS_COMMENT_CLASSIFIER=heuristic or the
// model isn't installed. Text patterns plus the structural features. The
// text is split into sentences, greetings ("Hi Mara,", "OK.") and leading
// @mentions are set aside, then, in order:
//   1. nonsubstantive  <= 25 words, and every sentence is a short
//                      agreement / thanks / acknowledgement ("+1", "Fine with
//                      accept.", "Thanks all."), with no question;
//   2. ping            a request ("please", "could you", "any update",
//                      "reminder", "chime in", ...) addressed to someone
//                      (@mention, "reviewer", "R2", "you", "all"), <= 90
//                      words; or a short AC/lead comment with a mention and a
//                      question;
//   3. reply           quotes earlier text, or a sentence opens like a
//                      response ("thanks for the clarification", "good point",
//                      "to your question", "I agree with R2 ..."), or refers
//                      to someone's point ("you wrote", "as R1 noted");
//   4. discussion      everything else.
// Confidences are fixed per path; a short "discussion" fallback is low.
// Bump HEURISTIC_ID when the rules change, so stored labels are recomputed.

import type { StructuralFeatures } from "./features.js";
import { COMMENT_KINDS, type CommentKind, type Prediction } from "./kinds.js";

export const HEURISTIC_ID = "heuristic-v2";

const GREETING = /^\s*((hi|hello|hey|dear)\b[^.,:;!?]{0,30}[,:!]|(ok|okay|hmm+|so|well|right)\s*[.,:!]|@[\p{L}\p{N}][\p{L}\p{N}._-]*(\s+[\p{Lu}][\p{L}-]+)?\s*[,:—–-]?)\s*/iu;

const AGREE =
  /^\W*(\+\s?1|ditto|same here|me too|agreed?|i (also )?agree|i concur|concur|seconded|second (this|that)|lgtm|sounds (good|fine|right|reasonable)|works for me|fine (by|with) me|ok(ay)?\b|thanks?\b|thank you|many thanks|no objections?|fine with|happy (with|to go with|to accept|to support)|i('m| am) (fine|ok|okay|happy|good) with|count me in|noted|ack(nowledged)?|yes,? agreed|i support|support (accept|reject|acceptance|rejection|this)|((weak )?accept|(weak )?reject|that|either( way| outcome)?) is fine|fine with either|nothing (to add|further)|no further comments?|all good|got it|will do|done\b|:\)|👍)/i;

const REQUEST =
  /\b(please|pls|could you|can you|would you|will you|would it be possible|any (update|updates|thoughts|news|progress)|(gentle |quick |friendly )?(reminder|nudge|nudging|ping|pinging)|waiting (for|on)|chime in|weigh in|take a look|have a look|look at (the|this)|let (us|me) know|when you (get|have) a (chance|moment)|still (need|waiting|missing)|have(n't| not) (heard|seen|yet)|are you (able|still)|post a (comment|note)|(please|kindly) (respond|reply)|respond (here|by|before|when)|reply here|update us|your (thoughts|take|view|opinion|input|position|recommendation)|kindly|we need (your|you)|we are (blocked|waiting)|i'?d (like|appreciate)|share your|post your|add your|follow(ing)?[ -]up|last call)\b/i;
const ADDRESS = /(@[\p{L}\p{N}]|\breviewers?\b|\b[Rr]\d\b|\byou\b|\ball\b|\beveryone\b|\bfolks\b|\bsomeone\b|^\s*(hi|hello|dear)\b)/iu;

const REPLY_OPENER =
  /^\W*(re:|thanks for (the|your|clarifying|explaining|raising|pointing|this)|thank you for (the|your|clarifying|explaining|raising|pointing)|thanks, that helps|good (point|catch|question)|fair (point|enough)|valid point|i see (your point|where)|i take your point|to (answer|address|respond to|reply to|your question)|in (response|reply|answer) to|responding to|replying to|regarding (your|the earlier|the previous|that)|on (your|the) (point|question|concern)|you('re| are) right|you have a point|as you (said|note|noted|point out|pointed out|mention|mentioned)|i (dis)?agree with (you|@|reviewer|r\d|the (ac|ac's|other|previous|first|second|third))|that('s| is) (a )?(fair|good|valid)|yes,|no,|indeed,|correct,|to clarify|let me clarify|following (the|your) (previous|earlier|last)?\s?(comment|point|question)|as (reviewer [a-e]|r\d|the (first|second|third) reviewer|the ac|you) (said|noted|pointed out|suggested|mentioned))/i;
const REPLY_ANYWHERE =
  /\b(you (wrote|said|mention(ed)?|asked|raise[sd]?|argue[ds]?|suggest(ed)?|point(ed)? out)|your (point|question|comment|concern|argument|suggestion|remark)|(reviewer [a-e]|r\d|the (first|second|third) reviewer)('s)? (point|question|comment|concern|argument)|(reviewer [a-e]|r\d|the (first|second|third) reviewer|the ac) (is right|raises|has a point)|as (reviewer [a-e]|r\d|the (first|second|third) reviewer|the ac|you) (said|noted|pointed out|suggested|mentioned)|the (previous|earlier|last) (comment|point|question)|(my|our) (earlier|previous) (comment|point)|i (missed|had misread|misread)|the ac's (question|note|summary)|that matches my reading)\b/i;

/** Sentences of `t`, each with its leading greeting / @mention stripped (empty ones dropped). */
function sentences(t: string): string[] {
  const out: string[] = [];
  for (let s of t.split(/(?<=[.!?])\s+|\n+/)) {
    for (let i = 0; i < 3; i++) {
      const m = GREETING.exec(s);
      if (!m || m[0].length === 0 || m[0].length >= s.length) break;
      s = s.slice(m[0].length);
    }
    s = s.trim();
    if (/[\p{L}\p{N}+]/u.test(s) || s.includes(":)")) out.push(s);
  }
  return out;
}

const words = (s: string) => s.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

function dist(kind: CommentKind, confidence: number): Prediction {
  const rest = (1 - confidence) / (COMMENT_KINDS.length - 1);
  const probs = Object.fromEntries(COMMENT_KINDS.map((k) => [k, k === kind ? confidence : rest])) as Record<CommentKind, number>;
  return { kind, confidence, probs };
}

/** Classify one comment from its text and structural features. */
export function classifyHeuristic(text: string, f: StructuralFeatures): Prediction {
  const t = text.trim();
  const n = f.words;
  const question = t.includes("?");
  const mentioned = f.mentions > 0;
  const ss = sentences(t);

  const trivial = (s: string) => AGREE.test(s) && words(s) <= 10;
  if (n <= 25 && !question && ss.length > 0 && ss.every(trivial)) return dist("nonsubstantive", n <= 10 ? 0.85 : 0.7);

  if (n <= 90 && REQUEST.test(t) && (mentioned || ADDRESS.test(t))) return dist("ping", mentioned || f.byAcOrLead ? 0.85 : 0.7);
  if (f.byAcOrLead && mentioned && question && n <= 60) return dist("ping", 0.7);

  if (f.quotes || ss.some((s) => REPLY_OPENER.test(s))) return dist("reply", 0.8);
  if (REPLY_ANYWHERE.test(t)) return dist("reply", 0.65);
  if (mentioned && !f.byAcOrLead && f.hoursSincePrev !== null && f.hoursSincePrev < 48) return dist("reply", 0.55);

  return dist("discussion", n >= 40 ? 0.7 : n >= 15 ? 0.6 : 0.45);
}
