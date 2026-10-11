// Comment types (spec §5e). A comment is exactly one of:
//   ping            a nudge asking someone to respond or act
//   reply           answers or responds to an earlier comment or review
//   discussion      a substantive argument about the paper
//   nonsubstantive  "agree", "+1", "thanks", "fine with accept"
// The labels describe comments, never people (spec §7).

export const COMMENT_KINDS = ["ping", "reply", "discussion", "nonsubstantive"] as const;
export type CommentKind = (typeof COMMENT_KINDS)[number];

export const KIND_LABEL: Readonly<Record<CommentKind, string>> = {
  ping: "Ping",
  reply: "Reply",
  discussion: "Discussion",
  nonsubstantive: "Non-substantive",
};

export const isCommentKind = (v: unknown): v is CommentKind => typeof v === "string" && (COMMENT_KINDS as readonly string[]).includes(v);

/** Where a comment's label came from: the chair's relabel, or a classifier. */
export type LabelSource = "chair" | "heuristic" | "model";

/** Class probabilities, in COMMENT_KINDS order. */
export type Probs = Readonly<Record<CommentKind, number>>;

export interface Prediction {
  kind: CommentKind;
  /** The predicted kind's probability (0..1). */
  confidence: number;
  probs: Probs;
}

/** The argmax of a probability vector in COMMENT_KINDS order. */
export function predictionOf(p: readonly number[]): Prediction {
  let best = 0;
  for (let i = 1; i < COMMENT_KINDS.length; i++) if (p[i]! > p[best]!) best = i;
  const probs = Object.fromEntries(COMMENT_KINDS.map((k, i) => [k, p[i] ?? 0])) as Record<CommentKind, number>;
  return { kind: COMMENT_KINDS[best]!, confidence: p[best]!, probs };
}
