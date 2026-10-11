// The inference worker thread (spec §5e). It locks the network first, then
// loads the local model, then answers embed requests from the main thread:
//   in:  { type: "embed", id, texts }
//   out: { type: "ready", id, dim } | { type: "result", id, data, n, dim } | { type: "error", id, message }
// Error messages never include the texts.

import { parentPort, workerData } from "node:worker_threads";
import { lockNetwork } from "./no-network.js";

lockNetwork();

const { modelDir, threads } = workerData as { modelDir: string; threads?: number };
const port = parentPort!;

const { createOnnxEmbedder } = await import("./onnx-embedder.js");
let embedder: Awaited<ReturnType<typeof createOnnxEmbedder>>;
try {
  embedder = await createOnnxEmbedder(modelDir, { threads });
  port.postMessage({ type: "ready", dim: embedder.dim, id: embedder.id });
} catch (e) {
  port.postMessage({ type: "error", id: 0, message: `could not load the model: ${(e as Error).message}` });
  process.exit(1);
}

port.on("message", (m: { type: "embed"; id: number; texts: string[] }) => {
  embedder.embed(m.texts).then(
    (vecs) => {
      const data = new Float32Array(vecs.length * embedder.dim);
      vecs.forEach((v, i) => data.set(v, i * embedder.dim));
      port.postMessage({ type: "result", id: m.id, n: vecs.length, dim: embedder.dim, data }, [data.buffer]);
    },
    (e: unknown) => port.postMessage({ type: "error", id: m.id, message: `inference failed: ${(e as Error).name}` }),
  );
});
