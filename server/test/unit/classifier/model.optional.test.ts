// OPTIONAL: runs only when PCS_MODEL_DIR (default data/models) holds the
// pinned, sha256-verified model; skipped otherwise. Tests never download it:
// the chair (or a developer) runs `pcs model fetch` by hand. Global fetch is
// stubbed to throw here as in every unit test, and inference runs in the
// network-locked worker.
import { describe, expect, it } from "vitest";
import { resolveModelDir } from "../../../src/config.js";
import { evaluateModel } from "../../../src/classifier/evaluate.js";
import { formatConfusion } from "../../../src/classifier/head.js";
import { MODEL, verifyModel } from "../../../src/classifier/model-files.js";
import { createWorkerEmbedder } from "../../../src/classifier/worker-embedder.js";

const dir = resolveModelDir(process.env.PCS_MODEL_DIR || "data/models");
const installed = (await verifyModel(dir)).ok;

describe.skipIf(!installed)(`the real model in ${dir} (optional)`, () => {
  it("embeds in a worker: 384-d unit vectors, similar texts closer than unrelated ones", async () => {
    const e = await createWorkerEmbedder(dir);
    try {
      expect(e.id).toBe(MODEL.id);
      const [a, b, c] = await e.embed(["+1, fine with accept.", "Agreed, accept is fine.", "The evaluation uses an outdated baseline."]);
      const dot = (x: Float32Array, y: Float32Array) => x.reduce((s, v, i) => s + v * y[i]!, 0);
      expect(a).toHaveLength(384);
      expect(dot(a!, a!)).toBeCloseTo(1, 4);
      expect(dot(a!, b!)).toBeGreaterThan(dot(a!, c!));
    } finally {
      await e.close?.();
    }
  }, 60_000);

  it("beats 90% on held-out synthetic templates", async () => {
    const e = await createWorkerEmbedder(dir);
    try {
      const r = await evaluateModel(e);
      process.stderr.write(`model, held-out templates:\n${formatConfusion(r.heldOut)}\nmodel, hard set:\n${formatConfusion(r.hard)}\n`);
      expect(r.heldOut.accuracy).toBeGreaterThan(0.9);
      expect(r.hard.accuracy).toBeGreaterThan(0.5);
    } finally {
      await e.close?.();
    }
  }, 120_000);
});
