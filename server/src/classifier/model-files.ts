// The local model's files (spec §5e, AGENTS.md rule 4): a pinned manifest,
// the sha256 check, and the two chair-run setup paths.
//
// - `pcs model fetch` downloads exactly MODEL.files from MODEL.baseUrl (one
//   pinned Hugging Face revision) with plain GETs: no body, no cookies, no
//   credentials, no query; nothing about the conference is sent. Each file is
//   written to a temp name, checked against its pinned size and sha256, and
//   only then renamed into place. It is never called automatically, at
//   runtime, or by tests (tests inject a fake fetch).
// - `pcs model install <dir|tarball>` copies the same files from a directory
//   or a .tar / .tar.gz the chair downloaded themselves, with the same check.
//   Only manifest paths are extracted from a tarball (no other entry is ever
//   written, so a crafted archive can't escape the model directory).
// - verifyModel() is what the app runs before using the model: every file
//   present with the pinned sha256, or the classifier falls back to the
//   heuristic.

import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";

export interface ModelFile {
  /** Path inside the model directory (and inside the repo at `revision`). */
  path: string;
  sha256: string;
  size: number;
}

/** The pinned model. Changing anything here is a deliberate, reviewed upgrade. */
export const MODEL = {
  /** Cache key for embeddings: changes whenever the weights could. */
  id: "all-MiniLM-L6-v2-q8@751bff3",
  name: "all-MiniLM-L6-v2, quantized ONNX (Xenova/all-MiniLM-L6-v2)",
  repo: "Xenova/all-MiniLM-L6-v2",
  revision: "751bff37182d3f1213fa05d7196b954e230abad9",
  baseUrl: "https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/751bff37182d3f1213fa05d7196b954e230abad9/",
  /** Licence of the weights (sentence-transformers/all-MiniLM-L6-v2, converted by Xenova). */
  licence: "Apache-2.0",
  /** Directory under PCS_MODEL_DIR. */
  subdir: "Xenova/all-MiniLM-L6-v2",
  dim: 384,
  /** sentence-transformers' max_seq_length for this model. */
  maxTokens: 256,
  files: [
    { path: "onnx/model_quantized.onnx", sha256: "afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1", size: 22_972_370 },
    { path: "tokenizer.json", sha256: "da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0", size: 711_661 },
    { path: "tokenizer_config.json", sha256: "9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3", size: 366 },
    { path: "config.json", sha256: "7135149f7cffa1a573466c6e4d8423ed73b62fd2332c575bf738a0d033f70df7", size: 650 },
  ] as readonly ModelFile[],
} as const;

export type ModelManifest = typeof MODEL;

/** Where the model's files live under PCS_MODEL_DIR. */
export const modelPath = (modelDir: string, m: { subdir: string } = MODEL): string => join(modelDir, m.subdir);

export class ModelFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelFileError";
  }
}

export async function sha256File(path: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest("hex");
}

export interface VerifyResult {
  ok: boolean;
  dir: string;
  missing: string[];
  /** Present, but the size or sha256 is wrong. */
  mismatched: string[];
}

const verified = new Map<string, string>();

/** Is every manifest file present with its pinned size and sha256? Cached per (file, size, mtime). */
export async function verifyModel(modelDir: string, m: Pick<ModelManifest, "files" | "subdir"> = MODEL): Promise<VerifyResult> {
  const dir = modelPath(modelDir, m);
  const missing: string[] = [];
  const mismatched: string[] = [];
  for (const f of m.files) {
    const p = join(dir, f.path);
    if (!existsSync(p)) {
      missing.push(f.path);
      continue;
    }
    const st = statSync(p);
    const key = `${p}:${st.size}:${st.mtimeMs}`;
    if (verified.get(p) === key) continue;
    if (st.size !== f.size || (await sha256File(p)) !== f.sha256) {
      mismatched.push(f.path);
      continue;
    }
    verified.set(p, key);
  }
  return { ok: missing.length === 0 && mismatched.length === 0, dir, missing, mismatched };
}

function checkBytes(f: ModelFile, bytes: Uint8Array): void {
  if (bytes.length !== f.size) throw new ModelFileError(`${f.path}: ${bytes.length} bytes, expected ${f.size}; not installed`);
  const got = createHash("sha256").update(bytes).digest("hex");
  if (got !== f.sha256) throw new ModelFileError(`${f.path}: sha256 ${got} does not match the pinned ${f.sha256}; not installed`);
}

/** Write a verified file atomically (temp name, then rename). */
function place(dir: string, f: ModelFile, bytes: Uint8Array): void {
  checkBytes(f, bytes);
  const p = join(dir, f.path);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.part`;
  writeFileSync(tmp, bytes);
  renameSync(tmp, p);
}

export type FetchLike = (url: string, init: { method: "GET"; redirect: "follow"; credentials: "omit"; headers: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

export interface FetchModelOptions {
  /** Injected in tests; the real one is the global fetch. */
  fetch?: FetchLike;
  log?: (line: string) => void;
  manifest?: ModelManifest;
}

/**
 * `pcs model fetch`: download the pinned files (plain GETs, nothing sent) and
 * install each one only if its size and sha256 match. Files already present
 * and verified are skipped.
 */
export async function fetchModel(modelDir: string, o: FetchModelOptions = {}): Promise<VerifyResult> {
  const m = o.manifest ?? MODEL;
  const doFetch = o.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const log = o.log ?? (() => undefined);
  const dir = modelPath(modelDir, m);
  const before = await verifyModel(modelDir, m);
  for (const f of m.files) {
    if (!before.missing.includes(f.path) && !before.mismatched.includes(f.path)) {
      log(`  ${f.path}: already installed and verified`);
      continue;
    }
    const url = new URL(f.path, m.baseUrl).toString();
    log(`  ${f.path}: GET ${url} (${(f.size / 1e6).toFixed(1)} MB)`);
    const res = await doFetch(url, { method: "GET", redirect: "follow", credentials: "omit", headers: { accept: "application/octet-stream" } });
    if (!res.ok) throw new ModelFileError(`${f.path}: HTTP ${res.status} from ${url}; nothing installed for this file`);
    place(dir, f, new Uint8Array(await res.arrayBuffer()));
    log(`  ${f.path}: sha256 verified`);
  }
  return verifyModel(modelDir, m);
}

// ---------------------------------------------------------------------------
// `pcs model install <dir|tarball>`

/** Entries of a (optionally gzipped) ustar/GNU/pax tar archive: name -> bytes, regular files only. */
export function readTar(archive: Uint8Array): Map<string, Uint8Array> {
  let buf = archive;
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = new Uint8Array(gunzipSync(buf));
  const out = new Map<string, Uint8Array>();
  const str = (b: Uint8Array) => {
    const end = b.indexOf(0);
    return new TextDecoder().decode(end < 0 ? b : b.subarray(0, end));
  };
  let pos = 0;
  let longName: string | undefined;
  while (pos + 512 <= buf.length) {
    const h = buf.subarray(pos, pos + 512);
    if (h.every((x) => x === 0)) break;
    const size = parseInt(str(h.subarray(124, 136)).trim() || "0", 8);
    if (!Number.isFinite(size) || size < 0) throw new ModelFileError("not a tar archive (bad entry size)");
    const type = String.fromCharCode(h[156] || 48);
    const magic = str(h.subarray(257, 263));
    const prefix = magic.startsWith("ustar") ? str(h.subarray(345, 500)) : "";
    let name = longName ?? (prefix ? `${prefix}/${str(h.subarray(0, 100))}` : str(h.subarray(0, 100)));
    longName = undefined;
    const body = buf.subarray(pos + 512, pos + 512 + size);
    if (body.length < size) throw new ModelFileError("truncated tar archive");
    if (type === "L") longName = str(body);
    else if (type === "x") {
      const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(new TextDecoder().decode(body));
      if (m) longName = m[1];
    } else if (type === "0" || type === "\0" || type === "7") {
      name = name.replace(/^\.\//, "");
      out.set(name, body);
    }
    pos += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

/** The archive entry or file for a manifest path: exact, or as a suffix after any leading directories. */
function findEntry<T>(entries: Map<string, T>, path: string): T | undefined {
  const exact = entries.get(path);
  if (exact !== undefined) return exact;
  const hits = [...entries.keys()].filter((k) => k.endsWith(`/${path}`));
  // The shortest match is the least nested (e.g. repo-root/onnx/..., not repo-root/sub/onnx/...).
  hits.sort((a, b) => a.length - b.length);
  return hits.length ? entries.get(hits[0]!) : undefined;
}

/** `pcs model install`: copy and verify the manifest files from a directory or a tarball. */
export async function installModel(modelDir: string, source: string, o: { manifest?: ModelManifest; log?: (l: string) => void } = {}): Promise<VerifyResult> {
  const m = o.manifest ?? MODEL;
  const log = o.log ?? (() => undefined);
  if (!existsSync(source)) throw new ModelFileError(`${source}: no such file or directory`);
  const dir = modelPath(modelDir, m);
  const read: (path: string) => Uint8Array | undefined = statSync(source).isDirectory()
    ? (p) => {
        for (const base of [source, join(source, m.subdir)]) {
          const f = join(base, p);
          if (existsSync(f) && statSync(f).isFile()) return readFileSync(f);
        }
        return undefined;
      }
    : (() => {
        const entries = readTar(readFileSync(source));
        return (p: string) => findEntry(entries, p);
      })();
  const missing = m.files.filter((f) => read(f.path) === undefined).map((f) => f.path);
  if (missing.length) throw new ModelFileError(`${source} lacks ${missing.join(", ")}; nothing installed`);
  // Check everything before writing anything.
  for (const f of m.files) checkBytes(f, read(f.path)!);
  for (const f of m.files) {
    place(dir, f, read(f.path)!);
    log(`  ${f.path}: sha256 verified, installed`);
  }
  return verifyModel(modelDir, m);
}

/** Remove the installed model files (not PCS_MODEL_DIR itself). */
export function removeModel(modelDir: string, m: Pick<ModelManifest, "subdir"> = MODEL): void {
  rmSync(modelPath(modelDir, m), { recursive: true, force: true });
}

