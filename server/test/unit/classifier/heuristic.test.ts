// The heuristic comment classifier and the synthetic set (spec §5e).
import { describe, expect, it } from "vitest";
import type { StructuralFeatures } from "../../../src/classifier/features.js";
import { featureVector, quotesEarlier, STRUCTURAL_DIM, textMentions } from "../../../src/classifier/features.js";
import { classifyHeuristic } from "../../../src/classifier/heuristic.js";
import { evaluateHeuristic } from "../../../src/classifier/evaluate.js";
import { COMMENT_KINDS } from "../../../src/classifier/kinds.js";
import { HARD_EXAMPLES, PER_CLASS, syntheticExamples } from "../../../src/classifier/synthetic.js";
import { NONSUBSTANTIVE_TEXT, PING_TEXT } from "@pcs/seed/scenarios/golden/scenario";

const f = (o: Partial<StructuralFeatures> & { text?: string } = {}): StructuralFeatures => ({
  byAcOrLead: false,
  mentions: o.text ? textMentions(o.text) : 0,
  words: o.text ? o.text.split(/\s+/).filter(Boolean).length : 10,
  hoursSincePrev: 20,
  authorHasReview: true,
  quotes: false,
  ...o,
});
const kind = (text: string, o: Partial<StructuralFeatures> = {}) => classifyHeuristic(text, f({ text, ...o })).kind;

describe("heuristic classifier", () => {
  it("non-substantive: short assent, thanks, +1", () => {
    for (const t of ["+1", "Agree.", "Thanks, all.", "Fine with accept.", "I'm fine with weak reject.", "Sounds good to me.", "No objections from my side.", "Hi Mara, LGTM."]) {
      expect(kind(t), t).toBe("nonsubstantive");
    }
  });
  it("a short agreement with an argument is not non-substantive", () => {
    expect(kind("I agree, but the baseline is too weak to support the claim.")).not.toBe("nonsubstantive");
    expect(kind("Agree?")).not.toBe("nonsubstantive");
  });
  it("ping: an addressed request", () => {
    expect(kind("@Mara could you please weigh in on the response?")).toBe("ping");
    expect(kind("Gentle reminder to Reviewer B: please post your view.", { byAcOrLead: true })).toBe("ping");
    expect(kind("Any update, everyone? We need a decision soon.")).toBe("ping");
  });
  it("reply: answers an earlier point, or quotes it", () => {
    expect(kind("Good point about the time budget; I had missed that.")).toBe("reply");
    expect(kind("To your question: yes, the artifact runs.")).toBe("reply");
    expect(kind("> the speedup holds on larger programs\nNot in Table 3 it doesn't.", { quotes: true })).toBe("reply");
  });
  it("discussion: the default for substantive text", () => {
    expect(kind("The evaluation compares against a single outdated baseline, and the subjects are small open-source projects, so the generalization claim in Section 5 is not supported.")).toBe("discussion");
  });
  it("labels the golden scenario's wording as expected.ts says", () => {
    expect(kind(`@Pat Pingleton ${PING_TEXT}`, { byAcOrLead: true, mentions: 1 })).toBe("ping");
    expect(kind(NONSUBSTANTIVE_TEXT, { byAcOrLead: true })).toBe("nonsubstantive");
    const filler = "The approach seems limited but the evaluation is thorough and the results are promising with some missing detail in the setup. Overall the contribution is modest however the writing is clear and the artifact is useful for replication in this study.";
    expect(kind(filler, { byAcOrLead: true })).toBe("discussion");
  });
  it("gives a probability distribution with the label's confidence", () => {
    const p = classifyHeuristic("+1", f({ text: "+1" }));
    expect(p.probs[p.kind]).toBe(p.confidence);
    expect(Object.values(p.probs).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    expect(classifyHeuristic("Hmm, maybe.", f({ text: "Hmm, maybe." })).confidence).toBeLessThan(0.6);
  });
  it("beats 85% on held-out synthetic templates and 45% on the hand-written hard set (honest, not tuned on it)", () => {
    const r = evaluateHeuristic();
    expect(r.heldOut.accuracy).toBeGreaterThan(0.85);
    expect(r.hard.accuracy).toBeGreaterThan(0.45);
  });
});

describe("structural features", () => {
  it("quotes: a '> ' line, or a quoted span found in earlier text", () => {
    expect(quotesEarlier("> the speedup holds\nno it doesn't", [])).toBe(true);
    expect(quotesEarlier('You say "the tool finds bugs that fuzzers miss" but where?', ["Our claim: the tool finds bugs that fuzzers miss."])).toBe(true);
    expect(quotesEarlier('A "made up phrase that nobody wrote" here', ["something else entirely"])).toBe(false);
  });
  it("feature vector: fixed length, scaled to 0..1", () => {
    const v = featureVector(f({ words: 5000, hoursSincePrev: 1e6 }));
    expect(v).toHaveLength(STRUCTURAL_DIM);
    for (const x of v) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(1);
    }
    expect(featureVector(f({ hoursSincePrev: null }))[3]).toBe(1);
  });
});

describe("synthetic set", () => {
  const ex = syntheticExamples();
  it(`has ${PER_CLASS} distinct examples per class, with held-out templates`, () => {
    for (const k of COMMENT_KINDS) {
      const mine = ex.filter((e) => e.kind === k);
      expect(mine).toHaveLength(PER_CLASS);
      expect(new Set(mine.map((e) => e.text)).size).toBe(PER_CLASS);
      expect(mine.filter((e) => e.split === "test").length).toBeGreaterThan(40);
      // A template is either train or test, never both.
      const tested = new Set(mine.filter((e) => e.split === "test").map((e) => e.template));
      for (const e of mine) if (e.split === "train") expect(tested.has(e.template)).toBe(false);
    }
  });
  it("is deterministic", () => {
    expect(syntheticExamples()).toBe(ex);
    expect(ex[0]!.id).toBe("ping:0:0");
  });
  it("is synthetic: no e-mail domain but example.org, no URLs", () => {
    for (const e of [...ex, ...HARD_EXAMPLES]) {
      for (const m of e.text.matchAll(/[\w.+-]+@([\w-]+\.[\w.-]+)/g)) expect(m[1]).toBe("example.org");
      expect(e.text).not.toMatch(/https?:\/\//);
    }
  });
  it("the hard set has 25 hand-written examples per class", () => {
    for (const k of COMMENT_KINDS) expect(HARD_EXAMPLES.filter((e) => e.kind === k)).toHaveLength(25);
  });
});
