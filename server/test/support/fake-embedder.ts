// A deterministic stand-in for the sentence-embedding model (spec §5e), for
// unit tests: hashed bag of words and word bigrams into `dim` buckets,
// L2-normalized. No model files, no inference, no network. It counts calls
// so tests can check that cached embeddings are reused.

import { createHash } from "node:crypto";
import type { Embedder } from "../../src/classifier/embedder.js";

export interface FakeEmbedder extends Embedder {
  /** Texts embedded so far (all calls). */
  readonly embedded: string[];
}

function bucket(token: string, dim: number): number {
  return createHash("sha1").update(token).digest().readUInt32LE(0) % dim;
}

export function fakeEmbedder(dim = 64, id = "fake-embedder-v1"): FakeEmbedder {
  const embedded: string[] = [];
  return {
    id,
    dim,
    embedded,
    async embed(texts) {
      embedded.push(...texts);
      return texts.map((t) => {
        const v = new Float32Array(dim);
        const words = t.toLowerCase().match(/[\p{L}\p{N}+@']+/gu) ?? [];
        words.forEach((w, i) => {
          v[bucket(w, dim)]! += 1;
          if (i > 0) v[bucket(`${words[i - 1]} ${w}`, dim)]! += 0.5;
        });
        let n = 0;
        for (const x of v) n += x * x;
        n = Math.sqrt(n) || 1;
        for (let i = 0; i < dim; i++) v[i]! /= n;
        return v;
      });
    },
  };
}
