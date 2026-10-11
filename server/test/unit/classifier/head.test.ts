// The model head: multinomial logistic regression trained in TS (spec §5e),
// on synthetic embeddings from a deterministic fake embedder.
import { describe, expect, it } from "vitest";
import { featureVector } from "../../../src/classifier/features.js";
import { confusion, formatConfusion, headProbs, predictHead, trainHead, trainingId } from "../../../src/classifier/head.js";
import { evaluateModel } from "../../../src/classifier/evaluate.js";
import { COMMENT_KINDS, type CommentKind } from "../../../src/classifier/kinds.js";
import { syntheticExamples } from "../../../src/classifier/synthetic.js";
import { fakeEmbedder } from "../../support/fake-embedder.js";

describe("trainHead / predictHead", () => {
  // Four well-separated clusters in 3-D.
  const centers: Record<CommentKind, number[]> = { ping: [1, 0, 0], reply: [0, 1, 0], discussion: [0, 0, 1], nonsubstantive: [-1, -1, -1] };
  const data = COMMENT_KINDS.flatMap((k) => [0, 1, 2, 3, 4].map((i) => ({ x: centers[k].map((c, j) => c + ((i + j) % 3) * 0.05), kind: k })));

  it("learns separable classes", () => {
    const h = trainHead(data);
    for (const d of data) expect(predictHead(h, d.x).kind).toBe(d.kind);
    const p = headProbs(h, centers.ping);
    expect(p.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    expect(predictHead(h, centers.ping).confidence).toBeGreaterThan(0.8);
  });

  it("is deterministic", () => {
    const a = trainHead(data);
    const b = trainHead(data);
    expect([...a.w]).toEqual([...b.w]);
    expect([...a.b]).toEqual([...b.b]);
  });

  it("sample weights pull the boundary (the chair's labels count more)", () => {
    // One point between ping and reply, labelled reply: with weight 50 it wins its own neighbourhood.
    const mid = [0.5, 0.5, 0];
    const light = trainHead([...data, { x: mid, kind: "reply" }]);
    const heavy = trainHead([...data, { x: mid, kind: "reply", weight: 50 }]);
    expect(headProbs(heavy, mid)[1]!).toBeGreaterThan(headProbs(light, mid)[1]!);
    expect(predictHead(heavy, mid).kind).toBe("reply");
  });

  it("rejects empty or ragged input", () => {
    expect(() => trainHead([])).toThrow(/no examples/);
    expect(() => trainHead([{ x: [1, 2], kind: "ping" }, { x: [1], kind: "reply" }])).toThrow(/dims/);
    expect(() => headProbs(trainHead(data), [1])).toThrow(/dims/);
  });

  it("training ids change with any part", () => {
    expect(trainingId(["a", "b"])).not.toBe(trainingId(["a", "c"]));
    expect(trainingId(["ab", "c"])).not.toBe(trainingId(["a", "bc"]));
  });
});

describe("confusion matrix", () => {
  it("rows are truth, columns predictions", () => {
    const c = confusion([
      { truth: "ping", predicted: "ping" },
      { truth: "ping", predicted: "reply" },
      { truth: "nonsubstantive", predicted: "nonsubstantive" },
    ]);
    expect(c.matrix[0]).toEqual([1, 1, 0, 0]);
    expect(c.matrix[3]).toEqual([0, 0, 0, 1]);
    expect(c.accuracy).toBeCloseTo(2 / 3);
    expect(formatConfusion(c)).toMatch(/accuracy 66\.7% \(n = 3\)/);
  });
});

describe("the head on synthetic embeddings (fake embedder)", () => {
  it("trains on the training templates and generalizes to held-out ones", async () => {
    const r = await evaluateModel(fakeEmbedder(256), "fake");
    // Bag-of-words hashing is a weak embedder; the real model is measured in model.optional.test.ts.
    expect(r.heldOut.accuracy).toBeGreaterThan(0.6);
    expect(r.heldOut.n).toBe(syntheticExamples().filter((e) => e.split === "test").length);
  });
  it("structural features alone are not enough to learn the classes (they overlap on purpose)", () => {
    const ex = syntheticExamples();
    const train = ex.filter((e) => e.split === "train");
    const h = trainHead(train.map((e) => ({ x: featureVector(e.features), kind: e.kind })));
    const test = ex.filter((e) => e.split === "test");
    const acc = confusion(test.map((e) => ({ truth: e.kind, predicted: predictHead(h, featureVector(e.features)).kind }))).accuracy;
    expect(acc).toBeLessThan(0.9);
  });
});
