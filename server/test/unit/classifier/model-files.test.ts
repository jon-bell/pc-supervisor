// The model's setup paths (AGENTS.md rule 4, spec §5e): `pcs model fetch`
// with a fake fetch (tests never download the model), `pcs model install`
// from a directory or tarball, and the sha256 check.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fetchModel, installModel, MODEL, ModelFileError, readTar, verifyModel, type FetchLike, type ModelManifest } from "../../../src/classifier/model-files.js";

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const A = new TextEncoder().encode("weights-weights-weights");
const B = new TextEncoder().encode('{"tokenizer": true}');
const manifest: ModelManifest = {
  ...MODEL,
  subdir: "test/tiny-model",
  baseUrl: "https://models.example.org/tiny/rev123/",
  files: [
    { path: "onnx/model.onnx", sha256: sha(A), size: A.length },
    { path: "tokenizer.json", sha256: sha(B), size: B.length },
  ],
} as unknown as ModelManifest;

/** A minimal ustar archive. */
function tar(entries: Record<string, Uint8Array>): Uint8Array {
  const blocks: Buffer[] = [];
  for (const [name, body] of Object.entries(entries)) {
    const h = Buffer.alloc(512);
    h.write(name, 0, 100);
    h.write("0000644\0", 100);
    h.write("0000000\0", 108);
    h.write("0000000\0", 116);
    h.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124);
    h.write("00000000000\0", 136);
    h.write("        ", 148);
    h.write("0", 156);
    h.write("ustar\0", 257);
    h.write("00", 263);
    let sum = 0;
    for (const x of h) sum += x;
    h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(h, Buffer.from(body), Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pcs-model-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("the pinned manifest", () => {
  it("pins a revision, a licence and a sha256 per file", () => {
    expect(MODEL.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(MODEL.baseUrl).toBe(`https://huggingface.co/${MODEL.repo}/resolve/${MODEL.revision}/`);
    expect(MODEL.licence).toBe("Apache-2.0");
    expect(MODEL.files.map((f) => f.path)).toContain("onnx/model_quantized.onnx");
    for (const f of MODEL.files) expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("fetchModel (fake fetch: tests never download the model)", () => {
  const fake = (body: (url: string) => Uint8Array | null): { fetch: FetchLike; calls: { url: string; init: unknown }[] } => {
    const calls: { url: string; init: unknown }[] = [];
    return {
      calls,
      fetch: async (url, init) => {
        calls.push({ url, init });
        const b = body(url);
        return { ok: b !== null, status: b ? 200 : 404, arrayBuffer: async () => (b ?? new Uint8Array()).slice().buffer };
      },
    };
  };

  it("GETs exactly the pinned URLs, sends nothing, verifies and installs", async () => {
    const f = fake((u) => (u.endsWith("model.onnx") ? A : B));
    const v = await fetchModel(dir, { fetch: f.fetch, manifest });
    expect(v.ok).toBe(true);
    expect(f.calls.map((c) => c.url)).toEqual(["https://models.example.org/tiny/rev123/onnx/model.onnx", "https://models.example.org/tiny/rev123/tokenizer.json"]);
    for (const c of f.calls) expect(c.init).toEqual({ method: "GET", redirect: "follow", credentials: "omit", headers: { accept: "application/octet-stream" } });
    expect(readFileSync(join(dir, "test/tiny-model/onnx/model.onnx"))).toEqual(Buffer.from(A));
    // Already verified: a second fetch downloads nothing.
    const again = fake(() => null);
    expect((await fetchModel(dir, { fetch: again.fetch, manifest })).ok).toBe(true);
    expect(again.calls).toEqual([]);
  });

  it("refuses a file whose sha256 doesn't match, and leaves nothing in place", async () => {
    const f = fake((u) => (u.endsWith("model.onnx") ? new TextEncoder().encode("weights-weights-tampered") : B));
    await expect(fetchModel(dir, { fetch: f.fetch, manifest })).rejects.toThrow(ModelFileError);
    expect(existsSync(join(dir, "test/tiny-model/onnx/model.onnx"))).toBe(false);
    expect((await verifyModel(dir, manifest)).ok).toBe(false);
  });

  it("reports HTTP errors", async () => {
    await expect(fetchModel(dir, { fetch: fake(() => null).fetch, manifest })).rejects.toThrow(/HTTP 404/);
  });
});

describe("installModel (files the chair downloaded)", () => {
  it("from a directory, at its root or under the model's subdir", async () => {
    const src = join(dir, "src");
    mkdirSync(join(src, "onnx"), { recursive: true });
    writeFileSync(join(src, "onnx/model.onnx"), A);
    writeFileSync(join(src, "tokenizer.json"), B);
    expect((await installModel(join(dir, "models"), src, { manifest })).ok).toBe(true);
  });

  it("from a .tar.gz with a leading directory; other entries (even ../ ones) are never written", async () => {
    const archive = gzipSync(tar({ "repo/onnx/model.onnx": A, "repo/tokenizer.json": B, "../evil.txt": new Uint8Array([1]), "repo/README.md": new Uint8Array([2]) }));
    const file = join(dir, "model.tar.gz");
    writeFileSync(file, archive);
    const models = join(dir, "models");
    expect((await installModel(models, file, { manifest })).ok).toBe(true);
    expect(existsSync(join(dir, "evil.txt"))).toBe(false);
    expect(existsSync(join(models, "test/tiny-model/README.md"))).toBe(false);
    expect([...readTar(archive).keys()]).toContain("repo/onnx/model.onnx");
  });

  it("checks every file before writing any", async () => {
    const src = join(dir, "src");
    mkdirSync(join(src, "onnx"), { recursive: true });
    writeFileSync(join(src, "onnx/model.onnx"), A);
    writeFileSync(join(src, "tokenizer.json"), new TextEncoder().encode("{}"));
    await expect(installModel(join(dir, "models"), src, { manifest })).rejects.toThrow(/tokenizer.json: \d+ bytes, expected/);
    expect(existsSync(join(dir, "models/test/tiny-model/onnx/model.onnx"))).toBe(false);
  });

  it("names missing files", async () => {
    await expect(installModel(join(dir, "models"), dir, { manifest })).rejects.toThrow(/lacks onnx\/model.onnx, tokenizer.json/);
  });
});
