// The model's head (spec §5e): multinomial logistic regression (softmax) over
// [sentence embedding ++ structural features], trained in TS, no Python.
//
// Training is full-batch gradient descent with Adam on the weighted
// cross-entropy plus an L2 penalty (bias unpenalized), from zero weights for
// a fixed number of epochs, so the same data always gives the same head.
// Sample weights let the chair's labels count more than synthetic examples
// (PCS_COMMENT_LABEL_WEIGHT). Cost: epochs x N x D x K multiply-adds; ~1,500
// examples x 391 dims x 4 classes x 300 epochs is well under a second.

import { createHash } from "node:crypto";
import { COMMENT_KINDS, predictionOf, type CommentKind, type Prediction } from "./kinds.js";

export interface Head {
  /** Input dimension. */
  dim: number;
  /** K x dim, row-major. */
  w: Float64Array;
  /** K. */
  b: Float64Array;
}

export interface TrainingExample {
  x: ArrayLike<number>;
  kind: CommentKind;
  /** Default 1. */
  weight?: number;
}

export interface TrainOptions {
  epochs?: number;
  learningRate?: number;
  /** L2 penalty on the weights. */
  l2?: number;
}

const K = COMMENT_KINDS.length;
const KIND_INDEX = new Map(COMMENT_KINDS.map((k, i) => [k, i]));

function softmaxInto(z: Float64Array, out: Float64Array): void {
  let m = -Infinity;
  for (let k = 0; k < K; k++) if (z[k]! > m) m = z[k]!;
  let s = 0;
  for (let k = 0; k < K; k++) {
    const e = Math.exp(z[k]! - m);
    out[k] = e;
    s += e;
  }
  for (let k = 0; k < K; k++) out[k]! /= s;
}

/** Train a softmax head. Throws on an empty set or mismatched dimensions. */
export function trainHead(examples: readonly TrainingExample[], o: TrainOptions = {}): Head {
  if (examples.length === 0) throw new Error("trainHead: no examples");
  const dim = examples[0]!.x.length;
  const epochs = o.epochs ?? 300;
  const lr = o.learningRate ?? 0.05;
  const l2 = o.l2 ?? 1e-4;
  const n = examples.length;
  const X = new Float64Array(n * dim);
  const Y = new Int32Array(n);
  const Wt = new Float64Array(n);
  let wsum = 0;
  examples.forEach((e, i) => {
    if (e.x.length !== dim) throw new Error(`trainHead: example ${i} has ${e.x.length} dims, expected ${dim}`);
    for (let j = 0; j < dim; j++) X[i * dim + j] = e.x[j]!;
    Y[i] = KIND_INDEX.get(e.kind)!;
    Wt[i] = e.weight ?? 1;
    wsum += Wt[i]!;
  });

  const w = new Float64Array(K * dim);
  const b = new Float64Array(K);
  const gw = new Float64Array(K * dim);
  const gb = new Float64Array(K);
  // Adam state.
  const mw = new Float64Array(K * dim);
  const vw = new Float64Array(K * dim);
  const mb = new Float64Array(K);
  const vb = new Float64Array(K);
  const beta1 = 0.9;
  const beta2 = 0.999;
  const eps = 1e-8;
  const z = new Float64Array(K);
  const p = new Float64Array(K);

  for (let t = 1; t <= epochs; t++) {
    gw.fill(0);
    gb.fill(0);
    for (let i = 0; i < n; i++) {
      const off = i * dim;
      for (let k = 0; k < K; k++) {
        let s = b[k]!;
        const wo = k * dim;
        for (let j = 0; j < dim; j++) s += w[wo + j]! * X[off + j]!;
        z[k] = s;
      }
      softmaxInto(z, p);
      const scale = Wt[i]! / wsum;
      for (let k = 0; k < K; k++) {
        const g = (p[k]! - (Y[i] === k ? 1 : 0)) * scale;
        if (g === 0) continue;
        gb[k]! += g;
        const wo = k * dim;
        for (let j = 0; j < dim; j++) gw[wo + j]! += g * X[off + j]!;
      }
    }
    const c1 = 1 - beta1 ** t;
    const c2 = 1 - beta2 ** t;
    for (let q = 0; q < w.length; q++) {
      const g = gw[q]! + l2 * w[q]!;
      mw[q] = beta1 * mw[q]! + (1 - beta1) * g;
      vw[q] = beta2 * vw[q]! + (1 - beta2) * g * g;
      w[q]! -= (lr * (mw[q]! / c1)) / (Math.sqrt(vw[q]! / c2) + eps);
    }
    for (let k = 0; k < K; k++) {
      const g = gb[k]!;
      mb[k] = beta1 * mb[k]! + (1 - beta1) * g;
      vb[k] = beta2 * vb[k]! + (1 - beta2) * g * g;
      b[k]! -= (lr * (mb[k]! / c1)) / (Math.sqrt(vb[k]! / c2) + eps);
    }
  }
  return { dim, w, b };
}

/** Class probabilities for one input, in COMMENT_KINDS order. */
export function headProbs(h: Head, x: ArrayLike<number>): number[] {
  if (x.length !== h.dim) throw new Error(`headProbs: input has ${x.length} dims, head expects ${h.dim}`);
  const z = new Float64Array(K);
  const p = new Float64Array(K);
  for (let k = 0; k < K; k++) {
    let s = h.b[k]!;
    const wo = k * h.dim;
    for (let j = 0; j < h.dim; j++) s += h.w[wo + j]! * x[j]!;
    z[k] = s;
  }
  softmaxInto(z, p);
  return [...p];
}

export function predictHead(h: Head, x: ArrayLike<number>): Prediction {
  return predictionOf(headProbs(h, x));
}

/** A short id for a training set: changes when any example, weight or option changes. */
export function trainingId(parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const p of parts) hash.update(p).update("\0");
  return hash.digest("hex").slice(0, 16);
}

/** Confusion matrix: rows = true kind, columns = predicted, in COMMENT_KINDS order. */
export function confusion(pairs: Iterable<{ truth: CommentKind; predicted: CommentKind }>): { matrix: number[][]; accuracy: number; n: number } {
  const m = COMMENT_KINDS.map(() => COMMENT_KINDS.map(() => 0));
  let n = 0;
  let ok = 0;
  for (const { truth, predicted } of pairs) {
    m[KIND_INDEX.get(truth)!]![KIND_INDEX.get(predicted)!]!++;
    n++;
    if (truth === predicted) ok++;
  }
  return { matrix: m, accuracy: n === 0 ? 0 : ok / n, n };
}

/** The confusion matrix as text (for `pcs model eval` and the docs). */
export function formatConfusion(c: { matrix: number[][]; accuracy: number; n: number }): string {
  const short: Record<CommentKind, string> = { ping: "ping", reply: "reply", discussion: "disc", nonsubstantive: "nonsub" };
  const head = ["truth \\ pred", ...COMMENT_KINDS.map((k) => short[k])].map((s) => s.padStart(8)).join(" ");
  const rows = COMMENT_KINDS.map((k, i) => [short[k], ...c.matrix[i]!.map(String)].map((s) => s.padStart(8)).join(" "));
  return [head, ...rows, `accuracy ${(c.accuracy * 100).toFixed(1)}% (n = ${c.n})`].join("\n");
}
