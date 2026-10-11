// Sentence embedders (spec §5e). The classifier only sees this interface:
// the real one runs the local ONNX model in a worker thread
// (worker-embedder.ts); tests use a deterministic fake.

export interface Embedder {
  /** Cache key for its vectors (model + revision). */
  readonly id: string;
  readonly dim: number;
  /** One unit-length vector per text, same order. */
  embed(texts: readonly string[]): Promise<Float32Array[]>;
  close?(): Promise<void>;
}

/** float32 vector <-> little-endian bytes, for the comment_embedding table. */
export function vecToBlob(v: Float32Array): Buffer {
  const b = Buffer.alloc(v.length * 4);
  for (let i = 0; i < v.length; i++) b.writeFloatLE(v[i]!, i * 4);
  return b;
}

export function blobToVec(b: Uint8Array): Float32Array {
  const buf = Buffer.from(b.buffer, b.byteOffset, b.byteLength);
  const v = new Float32Array(buf.length / 4);
  for (let i = 0; i < v.length; i++) v[i] = buf.readFloatLE(i * 4);
  return v;
}
