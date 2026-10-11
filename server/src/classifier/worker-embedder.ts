// The main-thread side of the inference worker (spec §5e): an Embedder whose
// embed() posts texts to embed-worker.ts and awaits the vectors, so model
// inference never blocks the server's event loop.
//
// Under tsx (npm run pcs / dev / tests) the worker is the .ts source and
// needs tsx's loader; from a built dist/ it is the .js file.

import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type { Embedder } from "./embedder.js";
import { MODEL } from "./model-files.js";

interface Pending {
  resolve: (v: Float32Array[]) => void;
  reject: (e: Error) => void;
}

export async function createWorkerEmbedder(modelDir: string, o: { threads?: number } = {}): Promise<Embedder> {
  const self = fileURLToPath(import.meta.url);
  const ts = self.endsWith(".ts");
  const file = fileURLToPath(new URL(ts ? "./embed-worker.ts" : "./embed-worker.js", import.meta.url));
  const threads = o.threads ?? Math.max(1, Math.min(4, availableParallelism() - 1));
  const worker = new Worker(file, {
    workerData: { modelDir, threads },
    execArgv: ts ? ["--import", "tsx"] : [],
    // The worker never needs the parent's environment (token, DB key).
    env: {},
  });
  worker.unref();
  const pending = new Map<number, Pending>();
  let next = 1;
  let dead: Error | undefined;

  const ready = new Promise<number>((resolve, reject) => {
    worker.once("message", (m: { type: string; dim?: number; message?: string }) => {
      if (m.type === "ready") resolve(m.dim!);
      else reject(new Error(m.message ?? "the inference worker failed to start"));
    });
    worker.once("error", reject);
  });
  const dim = await ready;
  worker.on("message", (m: { type: string; id: number; n?: number; dim?: number; data?: Float32Array; message?: string }) => {
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.type === "error") return p.reject(new Error(m.message));
    const out: Float32Array[] = [];
    for (let i = 0; i < m.n!; i++) out.push(m.data!.slice(i * m.dim!, (i + 1) * m.dim!));
    p.resolve(out);
  });
  const fail = (e: Error) => {
    dead = e;
    for (const p of pending.values()) p.reject(e);
    pending.clear();
  };
  worker.on("error", fail);
  worker.on("exit", (code) => fail(new Error(`the inference worker exited (${code})`)));

  return {
    id: MODEL.id,
    dim,
    embed(texts) {
      if (dead) return Promise.reject(dead);
      if (texts.length === 0) return Promise.resolve([]);
      const id = next++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.ref();
        worker.postMessage({ type: "embed", id, texts: [...texts] });
      }).finally(() => {
        if (pending.size === 0) worker.unref();
      }) as Promise<Float32Array[]>;
    },
    async close() {
      worker.removeAllListeners("exit");
      await worker.terminate();
    },
  };
}
