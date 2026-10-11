// The classification pipeline (spec §5e): incremental runs, embedding cache,
// the chair's labels (audited, weighted, retraining), and the snapshot.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fixedClock } from "../../../src/clock.js";
import type { CommentClassifierConfig } from "../../../src/config.js";
import { seedSyntheticComments } from "../../../src/classifier/evaluate.js";
import { HEURISTIC_ID } from "../../../src/classifier/heuristic.js";
import { CommentClassifier } from "../../../src/classifier/service.js";
import { effectiveLabels, labelGeneration, labelRevisions, pendingComments, relabel, RelabelError } from "../../../src/classifier/store.js";
import { memoryStore, type Store } from "../../../src/store/store.js";
import { textHash } from "../../../src/sync/text.js";
import { buildSnapshot } from "../../../src/views/snapshot.js";
import { fakeEmbedder, type FakeEmbedder } from "../../support/fake-embedder.js";

const NOW = new Date(Date.UTC(2030, 1, 26, 17));
const settings = (mode: CommentClassifierConfig["mode"]): CommentClassifierConfig => ({ mode, modelDir: "/nonexistent", minConfidence: 0.6, chairLabelWeight: 5 });
const classifier = (store: Store, mode: CommentClassifierConfig["mode"], embedder?: FakeEmbedder) =>
  new CommentClassifier(store, { acRole: { kind: "meta" }, commentClassifier: settings(mode) }, fixedClock(NOW), embedder ? { embedder: async () => embedder, assumeInstalled: true } : {});

function edit(store: Store, cid: number, text: string) {
  store.db.prepare("update comment set text_hash = ? where cid = ?").run(textHash(text), cid);
  store.db.prepare("insert into comment_text (cid, modified_at, seen_at, text) values (?, null, 1900000000, ?)").run(cid, text);
}

let store: Store;
beforeEach(() => {
  store = memoryStore();
  seedSyntheticComments(store, 40);
});
afterEach(() => store.close());

describe("heuristic runs", () => {
  it("classify every published comment once; a second run does nothing", async () => {
    const c = classifier(store, "heuristic");
    const first = await c.run();
    expect(first).toMatchObject({ classifier: "heuristic", classified: 40, embedded: 0 });
    expect(pendingComments(store.db, HEURISTIC_ID)).toEqual([]);
    expect((await c.run()).classified).toBe(0);
  });

  it("an edited comment is re-classified, and only it", async () => {
    const c = classifier(store, "heuristic");
    await c.run();
    edit(store, 7, "+1");
    expect((await c.run()).classified).toBe(1);
    expect(effectiveLabels(store.db, [7]).get(7)).toMatchObject({ kind: "nonsubstantive", source: "heuristic" });
  });

  it("skips drafts, responses and deleted comments", async () => {
    store.db.prepare("update comment set draft = 1 where cid = 1").run();
    store.db.prepare("update comment set is_response = 1 where cid = 2").run();
    store.db.prepare("update comment set deleted_seen_at = 1 where cid = 3").run();
    expect((await classifier(store, "heuristic").run()).classified).toBe(37);
  });

  it("off labels nothing", async () => {
    expect(await classifier(store, "off").run()).toMatchObject({ classifier: "off", classified: 0 });
  });

  it("model without verified files falls back to the heuristic and says so", async () => {
    const c = classifier(store, "model");
    expect(await c.active()).toBe("heuristic");
    expect((await c.status()).fallback).toMatch(/pcs model fetch/);
    expect((await c.run()).classifier).toBe("heuristic");
  });

  it("every label write bumps the generation (the analysis cache key)", async () => {
    const g0 = labelGeneration(store.db);
    await classifier(store, "heuristic").run();
    expect(labelGeneration(store.db)).toBeGreaterThan(g0);
  });
});

describe("model runs (fake embedder)", () => {
  it("embed each comment version once and re-use the vectors", async () => {
    const e = fakeEmbedder(64);
    const c = classifier(store, "model", e);
    const r = await c.run();
    expect(r).toMatchObject({ classifier: "model", classified: 40, embedded: 40 });
    const synthetic = e.embedded.length - 40;
    expect((await c.run()).classified).toBe(0);
    edit(store, 5, "Thanks, all good.");
    expect(await c.run()).toMatchObject({ classified: 1, embedded: 1 });
    expect(e.embedded.length).toBe(synthetic + 41);
  });

  it("a relabel retrains the head and re-predicts every comment from cached vectors", async () => {
    const e = fakeEmbedder(64);
    const c = classifier(store, "model", e);
    await c.run();
    const before = e.embedded.length;
    relabel(store.db, { cid: 9, kind: "ping", actor: "chair@example.org", atMs: NOW.getTime() });
    const r = await c.run();
    expect(r).toMatchObject({ classified: 40, embedded: 0 });
    expect(e.embedded.length).toBe(before);
    // The chair's label wins over the classifier's.
    expect(effectiveLabels(store.db, [9]).get(9)).toMatchObject({ kind: "ping", source: "chair", confidence: 1 });
  });

  it("labels survive a switch back to the heuristic, which re-labels with its own head", async () => {
    await classifier(store, "model", fakeEmbedder(64)).run();
    expect((await classifier(store, "heuristic").run()).classified).toBe(40);
  });
});

describe("the chair's labels", () => {
  it("are audited, append-only, and clearable", async () => {
    await classifier(store, "heuristic").run();
    const was = effectiveLabels(store.db, [4]).get(4)!;
    const r1 = relabel(store.db, { cid: 4, kind: "reply", actor: "chair@example.org", atMs: NOW.getTime() });
    expect(r1).toMatchObject({ cid: 4, pid: 1, kind: "reply", previous: was.kind, previousSource: "heuristic", actor: "chair@example.org", at: NOW.getTime() });
    expect(() => relabel(store.db, { cid: 4, kind: "reply", actor: "x", atMs: 0 })).toThrow(RelabelError);
    const r2 = relabel(store.db, { cid: 4, kind: null, actor: "chair@example.org", atMs: NOW.getTime() });
    expect(r2).toMatchObject({ kind: null, previous: "reply", previousSource: "chair" });
    expect(effectiveLabels(store.db, [4]).get(4)!.source).toBe("heuristic");
    expect(labelRevisions(store.db, { cid: 4 }).map((r) => r.id)).toEqual([r2.id, r1.id]);
    expect(() => store.db.prepare("delete from comment_label_revision").run()).toThrow(/append-only/);
    expect(() => store.db.prepare("update comment_label_revision set kind = 'ping'").run()).toThrow(/append-only/);
  });

  it("apply only to the text version they labelled", async () => {
    await classifier(store, "heuristic").run();
    relabel(store.db, { cid: 6, kind: "ping", actor: "c", atMs: 0 });
    edit(store, 6, "Agree.");
    await classifier(store, "heuristic").run();
    expect(effectiveLabels(store.db, [6]).get(6)).toMatchObject({ kind: "nonsubstantive", source: "heuristic" });
  });

  it("refuse unknown, deleted, draft and response comments", () => {
    expect(() => relabel(store.db, { cid: 999, kind: "ping", actor: "c", atMs: 0 })).toThrow(/no comment #999/);
    store.db.prepare("update comment set is_response = 1 where cid = 2").run();
    expect(() => relabel(store.db, { cid: 2, kind: "ping", actor: "c", atMs: 0 })).toThrow(/not classified/);
  });
});

describe("snapshot", () => {
  it("carries the effective kind and names the classifier, only when kinds are on", async () => {
    store.db.prepare("insert into paper (pid, title, status, tags, synced_at, first_seen_at) values (1, 'P', 'submitted', '[]', 0, 0)").run();
    await classifier(store, "heuristic").run();
    relabel(store.db, { cid: 2, kind: "ping", actor: "c", atMs: 0 });
    const on = buildSnapshot(store, { fields: { merit: "OveMer", expertise: "RevExp" }, acRole: { kind: "meta" }, commentKinds: true });
    expect(on.commentClassifier).toBe("heuristic");
    expect(on.comments.find((c) => c.cid === 2)!.kind).toBe("ping");
    expect(on.comments.every((c) => c.kind !== undefined)).toBe(true);
    const off = buildSnapshot(store, { fields: { merit: "OveMer", expertise: "RevExp" }, acRole: { kind: "meta" } });
    expect(off.commentClassifier).toBeNull();
    expect(off.comments.every((c) => c.kind === undefined)).toBe(true);
  });
});
