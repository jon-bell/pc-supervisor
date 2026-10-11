// The comment classifier, end to end (spec §5e).
//
// - Which classifier: PCS_COMMENT_CLASSIFIER. `model` uses the local model
//   when every pinned file in PCS_MODEL_DIR verifies; otherwise it falls back
//   to the heuristic and says why (the UI shows "heuristic" with a hint to run
//   `pcs model fetch`). `off` labels nothing.
// - Incremental: after a sync (and at server start), only comments whose
//   current text has no label from the current classifier head are
//   classified (pendingComments). Embeddings are cached per (comment, text
//   version, model), so a new head (after a relabel) re-predicts every
//   comment from cached vectors without running the model again.
// - The model's head is trained in-process on the synthetic set plus the
//   chair's labels (weighted PCS_COMMENT_LABEL_WEIGHT). Its id hashes the
//   model, the synthetic set version and the latest relabel, so labels from
//   an older head are recomputed.
// - Inference runs in a worker thread (worker-embedder.ts) with the network
//   locked; feature extraction and the head run here, per paper, from the
//   store. Nothing leaves the process.

import type { Clock } from "../clock.js";
import { DEFAULT_COMMENT_CLASSIFIER, type CommentClassifierConfig, type Config } from "../config.js";
import type { Store } from "../store/store.js";
import { wordCount } from "../sync/text.js";
import type { Embedder } from "./embedder.js";
import { featureVector, quotesEarlier, textMentions, type StructuralFeatures } from "./features.js";
import { predictHead, trainHead, trainingId, type Head, type TrainingExample } from "./head.js";
import { classifyHeuristic, HEURISTIC_ID } from "./heuristic.js";
import { MODEL, verifyModel } from "./model-files.js";
import {
  chairLabels,
  commentVersionText,
  getEmbeddings,
  labelCounts,
  latestLabelRevision,
  paperContext,
  pendingComments,
  pruneEmbeddings,
  putEmbeddings,
  writeClasses,
  type ClassRow,
  type PendingComment,
} from "./store.js";
import { SYNTHETIC_VERSION, syntheticExamples } from "./synthetic.js";
import { createWorkerEmbedder } from "./worker-embedder.js";

export type ActiveClassifier = "off" | "heuristic" | "model";

export interface ClassifierStatus {
  /** PCS_COMMENT_CLASSIFIER. */
  configured: ActiveClassifier;
  /** What is labelling comments now. */
  active: ActiveClassifier;
  /** Why `model` isn't active, when configured. */
  fallback: string | null;
  model: { name: string; licence: string; installed: boolean };
  minConfidence: number;
  running: boolean;
  /** Comments that can be labelled / have a current label / carry a chair label. */
  comments: number;
  labelled: number;
  chairLabels: number;
  byKind: Record<string, number>;
  lastRun: RunStats | null;
  lastError: string | null;
}

export interface RunStats {
  at: number;
  classifier: ActiveClassifier;
  classified: number;
  embedded: number;
  ms: number;
  /** Comments per second over the run (null when nothing was classified). */
  perSecond: number | null;
}

/** The pieces a run needs; tests inject a fake embedder. */
export interface ClassifierDeps {
  /** Creates the embedder for an installed, verified model. Default: the worker thread. */
  embedder?: (modelDir: string) => Promise<Embedder>;
  /** Skip the sha256 check (tests with a fake embedder and no model files). */
  assumeInstalled?: boolean;
  log?: (line: string) => void;
}

type Cfg = Pick<Config, "acRole"> & { commentClassifier?: CommentClassifierConfig | undefined };

const BATCH = 256;

export class CommentClassifier {
  readonly settings: CommentClassifierConfig;
  #embedder: Embedder | undefined;
  #embedderFailed: string | null = null;
  #head: { id: string; head: Head } | undefined;
  #synthetic: Float32Array[] | undefined;
  #running: Promise<RunStats> | undefined;
  #again: Promise<RunStats> | undefined;
  #last: RunStats | null = null;
  #lastError: string | null = null;
  #fallback: string | null = null;
  #installed = false;

  constructor(
    private readonly store: Store,
    private readonly cfg: Cfg,
    private readonly clock: Clock,
    private readonly deps: ClassifierDeps = {},
  ) {
    this.settings = cfg.commentClassifier ?? DEFAULT_COMMENT_CLASSIFIER;
  }

  get running(): boolean {
    return this.#running !== undefined;
  }

  /** Why `model` isn't in use (as of the last active() check), or null. */
  get fallback(): string | null {
    return this.#fallback;
  }

  /** Which classifier will run, after checking the model files. */
  async active(): Promise<ActiveClassifier> {
    const mode = this.settings.mode;
    if (mode !== "model") {
      this.#fallback = null;
      return mode;
    }
    if (this.#embedderFailed) {
      this.#fallback = this.#embedderFailed;
      return "heuristic";
    }
    this.#installed = this.deps.assumeInstalled || (await verifyModel(this.settings.modelDir)).ok;
    this.#fallback = this.#installed ? null : "the model is not installed; run `pcs model fetch` (or `pcs model install`)";
    return this.#installed ? "model" : "heuristic";
  }

  async status(): Promise<ClassifierStatus> {
    const active = await this.active();
    const c = labelCounts(this.store.db);
    return {
      configured: this.settings.mode,
      active,
      fallback: this.#fallback,
      model: { name: MODEL.name, licence: MODEL.licence, installed: this.#installed || (this.settings.mode !== "model" && (await verifyModel(this.settings.modelDir)).ok) },
      minConfidence: this.settings.minConfidence,
      running: this.running,
      comments: c.comments,
      labelled: c.labelled,
      chairLabels: c.chair,
      byKind: c.byKind,
      lastRun: this.#last,
      lastError: this.#lastError,
    };
  }

  /**
   * Classify pending comments. One run at a time: a call during a run queues
   * exactly one more run after it (so a relabel mid-run still retrains), and
   * further calls join that queued run.
   */
  run(): Promise<RunStats> {
    if (this.#running) {
      this.#again ??= this.#running.catch(() => undefined).then(() => {
        this.#again = undefined;
        return this.run();
      });
      return this.#again;
    }
    const p = this.#run()
      .then((s) => {
        this.#last = s;
        this.#lastError = null;
        return s;
      })
      .catch((e: unknown) => {
        this.#lastError = e instanceof Error ? e.message : String(e);
        throw e;
      })
      .finally(() => {
        this.#running = undefined;
      });
    this.#running = p;
    return p;
  }

  async close(): Promise<void> {
    await this.#running?.catch(() => undefined);
    await this.#embedder?.close?.();
    this.#embedder = undefined;
  }

  async #run(): Promise<RunStats> {
    const t0 = performance.now();
    const active = await this.active();
    const at = this.clock.now().getTime();
    if (active === "off") return { at, classifier: "off", classified: 0, embedded: 0, ms: 0, perSecond: null };
    let embedded = 0;
    let classified = 0;
    if (active === "model") {
      let embedder: Embedder;
      try {
        embedder = await this.#getEmbedder();
      } catch (e) {
        // A broken runtime (e.g. no prebuilt binary for this platform) falls back, loudly.
        this.#embedderFailed = `the model could not be loaded (${(e as Error).message}); using the heuristic`;
        this.deps.log?.(`comment types: ${this.#embedderFailed}`);
        return this.#run();
      }
      const head = await this.#modelHead(embedder);
      const pending = pendingComments(this.store.db, head.id);
      for (let i = 0; i < pending.length; i += BATCH) {
        const r = await this.#classifyModelBatch(pending.slice(i, i + BATCH), embedder, head, at);
        embedded += r.embedded;
        classified += r.classified;
      }
      pruneEmbeddings(this.store.db);
    } else {
      const pending = pendingComments(this.store.db, HEURISTIC_ID);
      for (let i = 0; i < pending.length; i += BATCH) {
        const batch = pending.slice(i, i + BATCH);
        const rows: ClassRow[] = [];
        for (const x of this.#withFeatures(batch)) {
          rows.push({ cid: x.cid, textHash: x.textHash, source: "heuristic", prediction: classifyHeuristic(x.text, x.features), head: HEURISTIC_ID, features: x.features });
        }
        writeClasses(this.store.db, rows, at);
        classified += rows.length;
      }
    }
    const ms = performance.now() - t0;
    return { at, classifier: active, classified, embedded, ms, perSecond: classified > 0 ? classified / (ms / 1000) : null };
  }

  async #getEmbedder(): Promise<Embedder> {
    if (!this.#embedder) this.#embedder = await (this.deps.embedder ?? createWorkerEmbedder)(this.settings.modelDir);
    return this.#embedder;
  }

  /** Text + structural features for comments, computed per paper from the store. */
  *#withFeatures(batch: readonly PendingComment[]): Generator<PendingComment & { text: string; features: StructuralFeatures }> {
    let pid = -1;
    let ctx: ReturnType<typeof paperContext> | undefined;
    for (const c of batch) {
      if (c.pid !== pid || !ctx) {
        pid = c.pid;
        ctx = paperContext(this.store, pid, this.cfg.acRole);
      }
      const idx = ctx.items.findIndex((x) => x.kind === "comment" && x.id === c.cid);
      if (idx < 0) continue;
      const me = ctx.items[idx]!;
      const earlier = ctx.items.slice(0, idx);
      const prev = earlier.length ? earlier[earlier.length - 1]! : null;
      const mentions = (this.store.db.prepare("select mentions from comment where cid = ?").get(c.cid) as { mentions: string } | undefined)?.mentions;
      const resolved = mentions ? (JSON.parse(mentions) as unknown[]).length : 0;
      yield {
        ...c,
        text: me.text,
        features: {
          byAcOrLead: ctx.acs.has(me.email),
          mentions: Math.max(resolved, textMentions(me.text)),
          words: wordCount(me.text),
          hoursSincePrev: prev ? Math.max(0, (me.at - prev.at) / 3_600_000) : null,
          authorHasReview: earlier.some((x) => x.kind === "review" && x.email === me.email),
          quotes: quotesEarlier(me.text, earlier.map((x) => x.text)),
        },
      };
    }
  }

  async #classifyModelBatch(batch: readonly PendingComment[], embedder: Embedder, head: { id: string; head: Head }, at: number) {
    const db = this.store.db;
    const cached = getEmbeddings(db, embedder.id, batch);
    const need = batch.filter((c) => !cached.has(c.cid));
    let embedded = 0;
    if (need.length) {
      const items = [...this.#withFeatures(need)];
      const vecs = await embedder.embed(items.map((x) => x.text));
      const rows = items.map((x, i) => ({ cid: x.cid, textHash: x.textHash, vec: vecs[i]!, features: x.features }));
      putEmbeddings(db, embedder.id, rows);
      for (const r of rows) cached.set(r.cid, { vec: r.vec, features: r.features });
      embedded = rows.length;
    }
    const out: ClassRow[] = [];
    for (const c of batch) {
      const e = cached.get(c.cid);
      if (!e) continue;
      out.push({ cid: c.cid, textHash: c.textHash, source: "model", prediction: predictHead(head.head, [...e.vec, ...featureVector(e.features)]), head: head.id, features: e.features });
    }
    writeClasses(db, out, at);
    return { embedded, classified: out.length };
  }

  /** Synthetic texts' embeddings (not confidential: invented text), once per process. */
  async #syntheticVecs(embedder: Embedder): Promise<Float32Array[]> {
    if (!this.#synthetic) this.#synthetic = await embedder.embed(syntheticExamples().map((e) => e.text));
    return this.#synthetic;
  }

  /** The head for the synthetic set + the chair's labels; retrained when either changes. */
  async #modelHead(embedder: Embedder): Promise<{ id: string; head: Head }> {
    const db = this.store.db;
    const rev = latestLabelRevision(db);
    const id = `model:${trainingId([embedder.id, SYNTHETIC_VERSION, String(rev), String(this.settings.chairLabelWeight)])}`;
    if (this.#head?.id === id) return this.#head;
    const syn = syntheticExamples();
    const vecs = await this.#syntheticVecs(embedder);
    const examples: TrainingExample[] = syn.map((e, i) => ({ x: [...vecs[i]!, ...featureVector(e.features)], kind: e.kind }));
    // The chair's labels, weighted higher. A label whose comment version has no
    // embedding yet (labelled under the heuristic) is embedded now.
    const labels = chairLabels(db);
    const have = getEmbeddings(db, embedder.id, labels);
    const missing = labels.filter((l) => !have.has(l.cid));
    if (missing.length) {
      const feats = new Map<number, StructuralFeatures>();
      for (const x of this.#withFeatures(missing)) feats.set(x.cid, x.features);
      const texts: { l: (typeof missing)[number]; text: string; features: StructuralFeatures }[] = [];
      for (const l of missing) {
        const text = commentVersionText(db, l.cid, l.textHash);
        const features = feats.get(l.cid) ?? (db.prepare("select features from comment_class where cid = ?").get(l.cid) as { features: string } | undefined)?.features;
        if (text !== undefined && features) texts.push({ l, text, features: typeof features === "string" ? (JSON.parse(features) as StructuralFeatures) : features });
      }
      const v = await embedder.embed(texts.map((t) => t.text));
      putEmbeddings(db, embedder.id, texts.map((t, i) => ({ cid: t.l.cid, textHash: t.l.textHash, vec: v[i]!, features: t.features })));
      for (const [cid, e] of getEmbeddings(db, embedder.id, missing)) have.set(cid, e);
    }
    for (const l of labels) {
      const e = have.get(l.cid);
      if (e) examples.push({ x: [...e.vec, ...featureVector(e.features)], kind: l.kind, weight: this.settings.chairLabelWeight });
    }
    this.#head = { id, head: trainHead(examples) };
    this.deps.log?.(`comment types: trained the model head on ${syn.length} synthetic + ${labels.length} chair label(s)`);
    return this.#head;
  }
}
