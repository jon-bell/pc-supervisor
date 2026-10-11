// Measuring the comment classifiers on held-out synthetic data (spec §5e),
// and a throughput bench over a synthetic in-memory store. Invented text
// only: nothing here reads the chair's store.

import { fixedClock } from "../clock.js";
import { memoryStore, type Store } from "../store/store.js";
import { textHash, wordCount } from "../sync/text.js";
import type { Embedder } from "./embedder.js";
import { featureVector } from "./features.js";
import { confusion, predictHead, trainHead } from "./head.js";
import { classifyHeuristic } from "./heuristic.js";
import type { CommentKind } from "./kinds.js";
import { CommentClassifier, type RunStats } from "./service.js";
import { HARD_EXAMPLES, syntheticExamples, type SyntheticExample } from "./synthetic.js";

export interface EvalResult {
  name: string;
  heldOut: ReturnType<typeof confusion>;
  hard: ReturnType<typeof confusion>;
}

/** The heuristic on the held-out templates and on the hand-written hard set. */
export function evaluateHeuristic(): EvalResult {
  const run = (xs: readonly SyntheticExample[]) => confusion(xs.map((e) => ({ truth: e.kind, predicted: classifyHeuristic(e.text, e.features).kind })));
  return { name: "heuristic", heldOut: run(syntheticExamples().filter((e) => e.split === "test")), hard: run(HARD_EXAMPLES) };
}

/** A head trained on the training templates only, scored on held-out templates and the hard set. */
export async function evaluateModel(embedder: Embedder, name = "model"): Promise<EvalResult> {
  const all = syntheticExamples();
  const vecs = await embedder.embed(all.map((e) => e.text));
  const x = (i: number) => [...vecs[i]!, ...featureVector(all[i]!.features)];
  const train = all.map((e, i) => ({ e, i })).filter(({ e }) => e.split === "train");
  const head = trainHead(train.map(({ e, i }) => ({ x: x(i), kind: e.kind })));
  const heldOut = confusion(all.map((e, i) => ({ e, i })).filter(({ e }) => e.split === "test").map(({ e, i }) => ({ truth: e.kind, predicted: predictHead(head, x(i)).kind })));
  const hv = await embedder.embed(HARD_EXAMPLES.map((e) => e.text));
  const hard = confusion(HARD_EXAMPLES.map((e, i) => ({ truth: e.kind, predicted: predictHead(head, [...hv[i]!, ...featureVector(e.features)]).kind })));
  return { name, heldOut, hard };
}

/**
 * Fill an in-memory store with `n` synthetic comments over n/4 papers (each
 * text a few synthetic examples joined, so lengths vary like real
 * discussions), for the throughput bench and the pipeline tests.
 */
export function seedSyntheticComments(store: Store, n: number, o: { startCid?: number; perPaper?: number } = {}): { cid: number; pid: number; kind: CommentKind }[] {
  const ex = syntheticExamples();
  const per = o.perPaper ?? 4;
  const start = o.startCid ?? 1;
  const ins = store.db.prepare(
    `insert into comment (cid, pid, email, topic, visibility, is_response, draft, by_author, by_shepherd, word_count, mentions, text_hash, modified_at, first_seen_at)
     values (?, ?, ?, null, 'rev', 0, 0, 0, 0, ?, '[]', ?, ?, ?)`,
  );
  const text = store.db.prepare("insert into comment_text (cid, modified_at, seen_at, text) values (?, ?, ?, ?)");
  const out: { cid: number; pid: number; kind: CommentKind }[] = [];
  store.db.transaction(() => {
    for (let i = 0; i < n; i++) {
      const cid = start + i;
      const pid = 1 + Math.floor(i / per);
      const base = ex[(i * 7919) % ex.length]!;
      // Every third discussion comment gets a second paragraph, for longer inputs.
      const t = base.kind === "discussion" && i % 3 === 0 ? `${base.text}\n\n${ex[(i * 104729) % ex.length]!.text}` : base.text;
      const at = 1_900_000_000 + i * 600;
      ins.run(cid, pid, `pc${i % 40}@example.org`, wordCount(t), textHash(t), at, at);
      text.run(cid, at, at, t);
      out.push({ cid, pid, kind: base.kind });
    }
  })();
  return out;
}

/** Classify `n` synthetic comments end to end (features, inference, head, writes); the run's stats. */
export async function benchPipeline(n: number, o: { mode: "heuristic" | "model"; modelDir: string; embedder?: (dir: string) => Promise<Embedder> }): Promise<RunStats> {
  const store = memoryStore();
  try {
    seedSyntheticComments(store, n);
    const c = new CommentClassifier(
      store,
      { acRole: { kind: "meta" }, commentClassifier: { mode: o.mode, modelDir: o.modelDir, minConfidence: 0.6, chairLabelWeight: 5 } },
      fixedClock(new Date(Date.UTC(2030, 1, 26, 12))),
      o.embedder ? { embedder: o.embedder } : {},
    );
    try {
      return await c.run();
    } finally {
      await c.close();
    }
  } finally {
    store.close();
  }
}
