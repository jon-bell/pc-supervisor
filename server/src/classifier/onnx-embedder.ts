// The local sentence-embedding model, in-process (spec §5e): the pinned
// all-MiniLM-L6-v2 ONNX weights run by onnxruntime-node, tokenized by
// @huggingface/tokenizers (BERT WordPiece, uncased), mean-pooled over the
// attention mask and L2-normalized, as sentence-transformers does.
//
// Loaded only inside the inference worker (embed-worker.ts), after
// lockNetwork(). Neither library is given a path or URL: the files are read
// here from PCS_MODEL_DIR and passed as bytes / parsed JSON, so there is
// nothing to download even in principle. Texts are batched by length to keep
// padding small; inputs over MODEL.maxTokens are truncated (keeping [SEP]).

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Embedder } from "./embedder.js";
import { MODEL, modelPath } from "./model-files.js";

const req = createRequire(import.meta.url);

interface OrtTensor {
  dims: readonly number[];
  data: Float32Array;
}
interface OrtSession {
  run(feeds: Record<string, unknown>): Promise<Record<string, OrtTensor>>;
  release?(): Promise<void>;
}
interface Ort {
  InferenceSession: { create(model: Uint8Array, o: Record<string, unknown>): Promise<OrtSession> };
  Tensor: new (type: "int64", data: BigInt64Array, dims: number[]) => unknown;
}
interface Tok {
  encode(text: string): { ids: number[] };
}

export class ModelUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelUnavailableError";
  }
}

export interface OnnxOptions {
  /** ONNX intra-op threads (default: up to 4). */
  threads?: number;
  batchSize?: number;
}

const CLS = 101;
const SEP = 102;

/** Load the pinned model from PCS_MODEL_DIR (files must already be verified). */
export async function createOnnxEmbedder(modelDir: string, o: OnnxOptions = {}): Promise<Embedder> {
  let ort: Ort;
  let TokenizerCtor: new (json: unknown, config: unknown) => Tok;
  try {
    ort = req("onnxruntime-node") as Ort;
    TokenizerCtor = (req("@huggingface/tokenizers") as { Tokenizer: typeof TokenizerCtor }).Tokenizer;
  } catch (e) {
    throw new ModelUnavailableError(`the ONNX runtime is not installed for this platform (${(e as Error).message.split("\n")[0]})`);
  }
  const dir = modelPath(modelDir);
  const tok = new TokenizerCtor(
    JSON.parse(readFileSync(join(dir, "tokenizer.json"), "utf8")),
    JSON.parse(readFileSync(join(dir, "tokenizer_config.json"), "utf8")),
  );
  const session = await ort.InferenceSession.create(readFileSync(join(dir, "onnx/model_quantized.onnx")), {
    intraOpNumThreads: o.threads ?? 4,
    interOpNumThreads: 1,
    graphOptimizationLevel: "all",
  });
  const batchSize = o.batchSize ?? 32;
  const max = MODEL.maxTokens;

  async function batch(ids: number[][]): Promise<Float32Array[]> {
    const B = ids.length;
    const L = Math.max(2, ...ids.map((x) => x.length));
    const inputIds = new BigInt64Array(B * L);
    const mask = new BigInt64Array(B * L);
    const types = new BigInt64Array(B * L);
    ids.forEach((x, i) => {
      for (let j = 0; j < x.length; j++) {
        inputIds[i * L + j] = BigInt(x[j]!);
        mask[i * L + j] = 1n;
      }
    });
    const out = await session.run({
      input_ids: new ort.Tensor("int64", inputIds, [B, L]),
      attention_mask: new ort.Tensor("int64", mask, [B, L]),
      token_type_ids: new ort.Tensor("int64", types, [B, L]),
    });
    const h = out.last_hidden_state!;
    const H = h.dims[2]!;
    const res: Float32Array[] = [];
    for (let i = 0; i < B; i++) {
      const v = new Float32Array(H);
      const n = ids[i]!.length;
      for (let j = 0; j < n; j++) {
        const off = (i * L + j) * H;
        for (let k = 0; k < H; k++) v[k]! += h.data[off + k]!;
      }
      let norm = 0;
      for (let k = 0; k < H; k++) {
        v[k]! /= n;
        norm += v[k]! * v[k]!;
      }
      norm = Math.sqrt(norm) || 1;
      for (let k = 0; k < H; k++) v[k]! /= norm;
      res.push(v);
    }
    return res;
  }

  return {
    id: MODEL.id,
    dim: MODEL.dim,
    async embed(texts) {
      const ids = texts.map((t) => {
        const x = tok.encode(t).ids;
        if (x.length <= max) return x.length ? x : [CLS, SEP];
        return [...x.slice(0, max - 1), SEP];
      });
      // Batch by length so padding stays small; results go back in input order.
      const order = ids.map((_, i) => i).sort((a, b) => ids[a]!.length - ids[b]!.length);
      const out = new Array<Float32Array>(texts.length);
      for (let s = 0; s < order.length; s += batchSize) {
        const part = order.slice(s, s + batchSize);
        const vecs = await batch(part.map((i) => ids[i]!));
        part.forEach((i, k) => (out[i] = vecs[k]!));
      }
      return out;
    },
    async close() {
      await session.release?.();
    },
  };
}
