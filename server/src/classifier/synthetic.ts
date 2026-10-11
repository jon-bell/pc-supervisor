// The synthetic labelled comment set (spec §5e): the default head's training
// data and the held-out set the classifiers are measured on.
//
// Every text is invented for this repo: hand-written templates about invented
// software-engineering papers, filled from hand-written slot lists with a
// fixed-seed RNG. Names are invented, and the only e-mail domain is
// example.org. Nothing comes from a real review or discussion.
//
// Each example also carries plausible structural features (features.ts),
// drawn per class with deliberate overlap, so the head can't learn the class
// from structure alone.
//
// Held-out split: by TEMPLATE, not by example. Every 5th template of each
// class (index % 5 === 4) is test-only, so the test set has sentence shapes
// the head never saw, and the reported accuracy isn't template memorisation.

import { COMMENT_KINDS, type CommentKind } from "./kinds.js";
import type { StructuralFeatures } from "./features.js";
import { textMentions } from "./features.js";

export interface SyntheticExample {
  /** Stable id: `${kind}:${template}:${n}`. */
  id: string;
  kind: CommentKind;
  text: string;
  features: StructuralFeatures;
  /** Index of the template within its class. */
  template: number;
  split: "train" | "test";
}

/** Bump when templates, slots or the generator change (it keys cached embeddings and heads). */
export const SYNTHETIC_VERSION = "synthetic-v1";

/** Examples generated per class. */
export const PER_CLASS = 360;

// ---------------------------------------------------------------------------
// Slots. All names are invented.

const FIRST = ["Mara", "Tobin", "Ilse", "Ravi", "Noemi", "Bastian", "Keiko", "Olu", "Petra", "Dario", "Sanna", "Wen", "Aurel", "Lio", "Fenna", "Joaquin", "Hedda", "Kofi", "Yara", "Emeric"];
const LAST = ["Quillfeather", "Marrowby", "Thistledown", "Ashgrove", "Brindlecombe", "Copperfield", "Dunwhistle", "Emberly", "Foxhollow", "Gorsemoor", "Hawkridge", "Ivywell", "Juniperlee", "Kestrelton", "Larkspur", "Mossbank"];
const REV = ["Reviewer A", "Reviewer B", "Reviewer C", "R1", "R2", "R3", "the first reviewer", "the second reviewer", "the third reviewer", "Reviewer D"];
const TOPIC = [
  "the fuzzing campaign", "the flaky-test detector", "the program-repair pipeline", "the code-review bot", "the regression-test selector",
  "the static analyzer", "the mutation-testing tool", "the API-misuse checker", "the refactoring recommender", "the build-failure predictor",
  "the log-parsing approach", "the energy profiler", "the microservice tracer", "the type-inference model", "the commit-message generator",
  "the dependency-update study", "the test-oracle generator", "the symbolic executor", "the CI cost model", "the vulnerability detector",
];
const ASPECT = [
  "the evaluation", "the baseline comparison", "the threats-to-validity section", "the dataset construction", "the user study",
  "the statistical analysis", "the ablation", "the related-work discussion", "the artifact", "the motivating example",
  "the choice of subjects", "the overhead measurements", "the precision numbers", "the recall numbers", "the generalizability argument",
];
const SEC = ["Section 3", "Section 4", "Section 4.2", "Section 5", "Section 5.3", "Table 2", "Table 4", "Figure 3", "Figure 7", "RQ1", "RQ2", "RQ3"];
const DEC = ["accept", "weak accept", "reject", "weak reject", "a major revision", "acceptance", "rejection"];
const WAIT = ["a week", "five days", "several days", "since Monday", "since the response period", "a few days", "since last Thursday", "ten days"];
const CLAIM = [
  "the speedup holds on larger programs", "the tool finds bugs that existing fuzzers miss", "the labels in the dataset are reliable",
  "the improvement is statistically significant", "the approach generalizes beyond Java", "the participants were representative",
  "the baseline was configured fairly", "the overhead is acceptable in practice", "the false-positive rate is low enough for developers",
  "the benchmark is free of duplicates", "the results transfer to industrial code", "the prompt design is not overfitted to the benchmark",
];
const CONCERN = [
  "the subjects are all small open-source projects", "the baseline is several years old", "there is no comparison with a simple heuristic",
  "the effect sizes are small", "the study has only twelve participants", "the training and test projects overlap",
  "the time budget differs between tools", "the oracle is the tool's own output", "half of the benchmark was used for tuning",
  "the threats section does not discuss construct validity", "the replication package is missing the scripts", "the precision is computed on a biased sample",
];
const STRENGTH = [
  "the problem is important and under-studied", "the artifact is complete and easy to run", "the writing is unusually clear",
  "the evaluation covers forty real projects", "the idea is simple and could be adopted quickly", "the qualitative analysis is careful",
  "the authors released a new benchmark", "the results are consistent across all research questions",
];

// ---------------------------------------------------------------------------
// Templates, hand-written per class. {who} = a person's first name, {full} =
// full name, {at} = "@First" or "@First Last", {rev}, {topic}, {aspect},
// {sec}, {dec}, {wait}, {claim}, {concern}, {strength}.

const PING: readonly string[] = [
  "{at}, could you please add your thoughts on the response? We are still missing your view.",
  "{at} any update on your reading of the rebuttal?",
  "Gentle reminder to {rev}: please post a comment on {aspect} when you get a chance.",
  "{at} please weigh in on whether {concern} is a deal breaker for you.",
  "Hi {who}, we haven't heard from you yet on this paper. Could you share your position before the deadline?",
  "{rev}, you are the most positive reviewer here. Could you say what convinced you about {topic}?",
  "Friendly nudge: {at} and {rev}, please take a look at the author response and update us.",
  "Could all reviewers please check {sec} again and let me know if your scores change?",
  "{at} we need your input to reach a decision. Can you comment by Friday?",
  "Reminder: discussion closes soon. {at}, please respond to the questions above.",
  "{at} you mentioned you would read the response again. Any news?",
  "Still waiting for {rev} to chime in. {at}, can you post a short note?",
  "{at} — would you be willing to champion this one, or should we move towards {dec}?",
  "Everyone, please have a look at the new discussion points and reply here.",
  "{at} could you clarify your expertise score? It would help the PC chairs.",
  "Pinging {at} again: we have been waiting {wait} for your comment.",
  "{who}, when you have a moment, please take a look at {aspect} and tell us whether it changes your mind.",
  "{at} {at}: please discuss and try to converge; the scores are far apart.",
  "Hi all, quick reminder that we need a consensus on this paper. {rev}, could you start us off?",
  "{at} can you please confirm whether you still support {dec} after the response?",
  "{at}, I'd appreciate your view on {concern}. Please reply when you can.",
  "Following up on my earlier message: {at}, are you still able to comment on this paper?",
  "Kindly respond, {at}. The other reviewers would like to hear your take on {topic}.",
  "{rev} please read the rebuttal and post a comment, even a short one.",
  "{at} would you mind looking at {sec}? I think your question is answered there. Let us know.",
  "As the AC I need everyone's position by Wednesday. {at}, please add yours.",
  "{at} please update your review or leave a comment explaining your score.",
  "{who}, we are blocked on your input. Can you take a quick look today?",
  "{at} do you agree with the proposed outcome? Please reply either way.",
  "Nudging {at}: your review raised {concern}. Is that resolved by the response?",
  "Could you two ({at} and {rev}) talk this through here? I'd like to understand the gap in scores.",
  "{at} reminder that we still need your comment on the response.",
  "Hello {who}, a follow-up on this paper: please share your current recommendation.",
  "{at}: any thoughts? You have not commented yet.",
  "Please, {rev}, add a sentence on whether {claim} convinced you.",
  "{at} we are waiting on you before we can close the discussion. Thanks in advance.",
  "Can someone with more expertise in {topic} weigh in? {at}, perhaps you?",
  "{at} please have a look when you get a chance — the authors addressed {aspect}.",
  "Last call for comments on this one. {at} and {rev}, please post your final view.",
  "{at} if you have time today, could you respond to the AC's question above?",
  "{at} I'd like to hear your opinion before I write the metareview. Can you comment?",
  "Hi {rev}, it would help a lot if you could reply to the questions about {aspect}.",
  "{at} please let us know if you still lean towards {dec}.",
  "Quick ping, {at}: we need your view on {topic} to move forward.",
  "{at}, are you still with us? Please post when you can.",
];

const REPLY: readonly string[] = [
  "Thanks for the clarification, {who}. That addresses my question about {aspect}.",
  "Good point about {concern}. I had not considered that, and it lowers my confidence in the results.",
  "To answer the AC's question: yes, I read the response, and it does not change my view on {aspect}.",
  "{at} you wrote that {claim}, but {sec} only shows this for two of the subjects.",
  "I see your point, but I think {concern} matters less than you suggest because the effect is consistent.",
  "Regarding your point on {aspect}: I checked {sec} again and the numbers do support the claim.",
  "Fair point. I agree with {rev} that {concern}, and I am lowering my score to {dec}.",
  "In response to {rev}: the authors do discuss this in {sec}, although briefly.",
  "You're right that {concern}. Still, I think {strength}, which is why I lean towards {dec}.",
  "> {claim}\nI am not sure this follows from {sec}; the variance is large.",
  "As you noted, {who}, {concern}. The response promises a fix, but we cannot verify it.",
  "Re: {aspect} — I agree with the previous comment that it is the main weakness.",
  "Thanks for raising this. On reflection I think {rev} is right about {aspect}.",
  "I disagree with {rev} here: {strength}, and that outweighs {concern} for me.",
  "Yes, I read the rebuttal. The answer about {aspect} is convincing, the one about {topic} less so.",
  "To clarify my earlier comment: my concern was not the numbers in {sec} but how they were obtained.",
  "{at} to your question: I would be fine with {dec} if the authors commit to fixing {aspect}.",
  "That's a fair summary of my position, {who}. I would only add that {concern}.",
  "Responding to the AC: I still think {concern}, but I can live with {dec}.",
  "Indeed, {rev} raises the right question. The response says {claim}, which I find plausible.",
  "Thanks for pointing to {sec}. I missed that; my concern about {aspect} is mostly resolved.",
  "No, I don't think the response settles it. As I said in my review, {concern}.",
  "On your question about {topic}: the tool is evaluated only on the authors' own benchmark.",
  "{at} good catch. I re-ran the numbers from {sec} and you are right, the gain is smaller.",
  "Let me clarify what I meant by weak baselines: {concern}.",
  "I agree with the AC's summary, with one caveat: {concern}.",
  "As {rev} pointed out, {aspect} is thin. I share that view after reading the response.",
  "Thank you for explaining, {who}. With that context I am moving my score up by one.",
  "Your concern about {aspect} is valid, but the authors do report it in {sec}.",
  "Correct, the authors did not answer the question about {topic}. I would ask them again in the metareview.",
  "{at} I take your point. Let's go with {dec} and list {concern} as a required change.",
  "In answer to {rev}: I am an expert in {topic}, and I don't think {claim}.",
  "Following the previous comment, I looked at the artifact. It runs, and the numbers in {sec} reproduce.",
  "Thanks, that helps. So the disagreement is really about whether {concern} matters.",
  "I see where {rev} is coming from, but in my reading {strength}.",
  "Yes, that matches my reading of {sec}.",
  "Regarding the earlier question on {aspect}: the response answers it only partially.",
  "{at} fair enough — I had misread {sec}. I withdraw that part of my criticism.",
  "To respond to {who}'s point: even granting {claim}, {concern}.",
  "Good question from {rev}. I asked myself the same thing and could not find an answer in the paper.",
  "> {concern}\nAgreed this is real, but the authors' response explains why it does not affect RQ1.",
  "That is a good summary, {who}, thank you. My remaining issue is {aspect}.",
  "Replying to the AC's note: I would support {dec} if the other reviewers agree.",
  "You asked whether {claim}. From {sec}, I would say only partially.",
  "I agree with {rev} on {aspect} but not on {topic}; there I think {strength}.",
];

const DISCUSSION: readonly string[] = [
  "My main concern remains {aspect}. {Concern}, so I am not convinced that {claim}. On the other hand, {strength}.",
  "After reading the response, I think the paper is borderline. {Strength}, but {concern}. I would lean towards {dec}.",
  "The key question for me is whether {claim}. {Sec} suggests it does on small programs, but {concern}.",
  "I want to argue for this paper. {Strength}. The weaknesses in {aspect} are real but fixable in a camera-ready.",
  "I remain negative. {Concern}, and the response does not address it. Without that, the central claim is unsupported.",
  "Let me summarize where I think we are: everyone agrees that {strength}, but there is disagreement about {aspect}.",
  "The evaluation in {sec} compares against a single baseline. {Concern}. I think this limits what we can conclude about {topic}.",
  "On novelty: {topic} is close to prior work on similar tools, but {strength}. I would call it incremental but useful.",
  "I tried the artifact. It builds, but {concern}. This makes me doubt that {claim}.",
  "Overall I find {topic} convincing. {Strength}, and {sec} is solid. My remaining issue is minor: {concern}.",
  "The threats to validity are understated. {Concern}, and the authors should at least discuss it.",
  "I think the disagreement comes from different expectations. If we judge it as a tool paper, {strength}; as a research paper, {concern}.",
  "Two issues stand out. First, {concern}. Second, {aspect} does not support the generalization claims.",
  "Having re-read {sec}, I am more positive than before. {Strength}, and I now believe {claim}.",
  "I am still torn on this one. {Strength}. However, {concern}, and that weakens the main result.",
  "For the record, my score reflects {aspect}: {concern}. The writing and motivation are fine.",
  "I believe the contribution is significant: {strength}. Requiring a new baseline seems unfair given the scope.",
  "The statistics in {sec} need more care. With {concern}, a p-value alone is not enough to claim that {claim}.",
  "From an industrial perspective, {topic} would be valuable, but {concern} limits adoption.",
  "I'd like us to weigh {strength} against {concern}. For me the first wins, so I support {dec}.",
  "The response clarified {aspect}, but the larger problem remains: {concern}.",
  "The paper's framing oversells the results. {Sec} shows modest gains, and {concern}.",
  "We should distinguish what the paper shows from what it claims. It shows that {strength}; it claims that {claim}, which is not established.",
  "My expertise is in {topic}. In this area, {concern} is a known pitfall, and the paper falls into it.",
  "I think {aspect} is adequate for this venue. {Strength}, and the missing comparison would be nice to have but not essential.",
  "Let me add a point nobody has raised: {concern}. That affects every research question.",
  "The paper would be much stronger with a discussion of failure cases. Right now {concern}, and we cannot tell when the approach breaks.",
  "On balance I lean positive. {Strength}, the response was candid about {aspect}, and the remaining issues are presentation.",
  "I disagree with the framing of the contribution, not with the results. {Strength}, but the paper should not claim that {claim}.",
  "The core technique in {topic} is sound. My doubts are about {aspect}: {concern}.",
  "I looked into the dataset more closely. {Concern}. Unless the authors fix this, the precision numbers are not meaningful.",
  "This is a solid empirical paper. {Strength}. The limitations are acknowledged honestly in {sec}.",
  "I am lowering my score. On a second reading, {concern}, and {aspect} relies on it.",
  "I'd keep my score. The response restates the claims but does not add evidence that {claim}.",
  "Consider the reviewers' concerns together: {concern}, and also the baseline issue. Combined, they make the conclusion weak.",
  "What would change my mind is evidence that {claim}. {Sec} hints at it but the sample is small.",
  "I think the PC should accept this despite {concern}, because {strength}.",
  "The paper addresses an important problem, but the evaluation design has a basic flaw: {concern}.",
  "Separating presentation from substance: the writing needs work, but substantively {strength}.",
  "The authors' answer on {aspect} is reasonable, but it raises a new question about whether {claim}.",
  "I am the low score here, so let me explain. {Concern}. I would need to see a fix before supporting it.",
  "Comparing with last year's papers on {topic}, this one is stronger: {strength}. I would accept.",
  "The core result in {sec} is promising, but I worry that {concern}. A short replication on other subjects would settle it.",
  "I read all reviews and the response. The positive reviews focus on {strength}; the negative ones on {concern}. Both are right.",
  "Even if {claim}, the practical impact is unclear, because {concern}.",
];

const NONSUB: readonly string[] = [
  "+1",
  "Agree.",
  "I agree with the AC.",
  "Thanks!",
  "Fine with {dec}.",
  "Sounds good to me.",
  "Works for me.",
  "No objections.",
  "Agreed, {dec} it is.",
  "Thanks, {who}.",
  "Me too.",
  "I concur with the summary.",
  "OK with the decision.",
  "Happy with {dec}.",
  "+1 to {rev}.",
  "Same here.",
  "Thanks all.",
  "LGTM.",
  "I'm fine with {dec}.",
  "Noted, thanks.",
  "Agree with the proposed outcome.",
  "Thank you, everyone.",
  "Fine by me.",
  "Seconded.",
  "Yes, agreed.",
  "Nothing to add.",
  "I support {dec}.",
  "Count me in for {dec}.",
  "Thanks for the summary.",
  "I'm happy with the consensus.",
  "Okay, {dec} is fine.",
  "Agree with {who}.",
  "No further comments from me.",
  "Fine with the majority view.",
  "Thanks, all good.",
  "Ditto.",
  "+1, thanks {who}.",
  "Agreed with everything above.",
  "I'm OK with that.",
  "Fine with either outcome.",
  "Thank you for organizing this, {who}.",
  "Sounds right.",
  "Agree, thanks.",
  "Happy to go with the AC's recommendation.",
  "Got it, thanks.",
];

export const TEMPLATES: Readonly<Record<CommentKind, readonly string[]>> = {
  ping: PING,
  reply: REPLY,
  discussion: DISCUSSION,
  nonsubstantive: NONSUB,
};

// Wrappers that vary the surface without changing the class.
const OPEN: Readonly<Record<CommentKind, readonly string[]>> = {
  ping: ["", "", "", "Hi all. ", "Hello, ", "Dear reviewers, "],
  reply: ["", "", "", "Hi {who}, ", "OK. ", "Hmm. "],
  discussion: ["", "", "", "Some thoughts. ", "After the response: ", "Summary of my view: "],
  nonsubstantive: ["", "", "", "", "Hi, ", "OK, "],
};
const CLOSE: Readonly<Record<CommentKind, readonly string[]>> = {
  ping: ["", "", "", " Thanks!", " Thank you.", " Thanks in advance."],
  reply: ["", "", "", " Thanks.", " Hope that helps.", ""],
  discussion: ["", "", "", " Happy to discuss further.", " Curious what others think.", ""],
  nonsubstantive: ["", "", "", "", " :)", ""],
};

// ---------------------------------------------------------------------------
// Generator

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function fill(template: string, r: () => number): string {
  const who = pick(r, FIRST);
  const last = pick(r, LAST);
  const at = r() < 0.5 ? `@${who}` : `@${who} ${last}`;
  const slot = (name: string): string => {
    switch (name.toLowerCase()) {
      case "who":
        return who;
      case "full":
        return `${who} ${last}`;
      case "at":
        return r() < 0.15 ? `@${pick(r, FIRST)}` : at;
      case "rev":
        return pick(r, REV);
      case "topic":
        return pick(r, TOPIC);
      case "aspect":
        return pick(r, ASPECT);
      case "sec":
        return pick(r, SEC);
      case "dec":
        return pick(r, DEC);
      case "wait":
        return pick(r, WAIT);
      case "claim":
        return pick(r, CLAIM);
      case "concern":
        return pick(r, CONCERN);
      case "strength":
        return pick(r, STRENGTH);
      default:
        throw new Error(`synthetic: unknown slot {${name}}`);
    }
  };
  return template.replace(/\{(\w+)\}/g, (_, name: string) => {
    const v = slot(name);
    return name[0] === name[0]!.toUpperCase() ? cap(v) : v;
  });
}

const wordCount = (s: string) => s.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

/** Structural features by class, overlapping on purpose. */
function features(kind: CommentKind, text: string, r: () => number): StructuralFeatures {
  const p = (x: number) => r() < x;
  const hours = (lo: number, hi: number) => Math.round(Math.exp(Math.log(lo) + r() * (Math.log(hi) - Math.log(lo))) * 10) / 10;
  const mentions = textMentions(text);
  const quotes = /^\s*>/m.test(text);
  switch (kind) {
    case "ping":
      return { byAcOrLead: p(0.75), mentions, words: wordCount(text), hoursSincePrev: p(0.08) ? null : hours(6, 400), authorHasReview: p(0.3), quotes };
    case "reply":
      return { byAcOrLead: p(0.3), mentions, words: wordCount(text), hoursSincePrev: hours(0.3, 72), authorHasReview: p(0.8), quotes };
    case "discussion":
      return { byAcOrLead: p(0.2), mentions, words: wordCount(text), hoursSincePrev: p(0.15) ? null : hours(1, 300), authorHasReview: p(0.85), quotes };
    case "nonsubstantive":
      return { byAcOrLead: p(0.3), mentions, words: wordCount(text), hoursSincePrev: hours(0.2, 96), authorHasReview: p(0.75), quotes };
  }
}

let cached: readonly SyntheticExample[] | undefined;

/** The whole synthetic set, deterministic (same output on every call and machine). */
export function syntheticExamples(): readonly SyntheticExample[] {
  if (cached) return cached;
  const out: SyntheticExample[] = [];
  COMMENT_KINDS.forEach((kind, ki) => {
    const r = rng(0x5eed + ki * 7919);
    const templates = TEMPLATES[kind];
    const seen = new Set<string>();
    let n = 0;
    for (let attempt = 0; n < PER_CLASS && attempt < PER_CLASS * 20; attempt++) {
      const template = attempt % templates.length;
      const body = fill(templates[template]!, r);
      const open = fill(pick(r, OPEN[kind]), r);
      // A quoting template keeps its "> " at the start of a line.
      let text = `${open}${open && body.startsWith(">") ? "\n" : ""}${body}${pick(r, CLOSE[kind])}`.trim();
      // Surface noise: lower case, no final period.
      if (r() < 0.08) text = text.toLowerCase();
      if (r() < 0.08) text = text.replace(/[.!]$/, "");
      if (seen.has(text)) continue;
      seen.add(text);
      out.push({
        id: `${kind}:${template}:${n}`,
        kind,
        text,
        features: features(kind, text, r),
        template,
        split: template % 5 === 4 ? "test" : "train",
      });
      n++;
    }
  });
  cached = out;
  return out;
}
