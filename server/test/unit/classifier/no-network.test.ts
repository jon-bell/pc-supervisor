// AGENTS.md rule 4: the local model reads comment text only in-process, with
// no network access at inference time. These tests check the inference path
// can't reach the network, without the model (tests never download it).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";

const src = (f: string) => readFileSync(fileURLToPath(new URL(`../../../src/classifier/${f}`, import.meta.url)), "utf8");
const code = (f: string) => src(f).replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

/** Run `body` (async JS, `lock` in scope) in a fresh worker thread that has called lockNetwork(). */
function inLockedWorker(body: string): Promise<Record<string, string>> {
  const mod = new URL("../../../src/classifier/no-network.ts", import.meta.url).href;
  const script = `
    const { parentPort } = require("node:worker_threads");
    (async () => {
      const { lockNetwork } = await import(${JSON.stringify(mod)});
      lockNetwork();
      const out = {};
      const attempt = async (name, fn) => { try { await fn(); out[name] = "allowed"; } catch (e) { out[name] = e.name + ": " + e.message; } };
      ${body}
      parentPort.postMessage(out);
    })().catch((e) => parentPort.postMessage({ fatal: String(e && e.stack || e) }));`;
  return new Promise((resolve, reject) => {
    const w = new Worker(script, { eval: true, execArgv: ["--import", "tsx"] });
    w.once("message", (m) => {
      void w.terminate();
      resolve(m as Record<string, string>);
    });
    w.once("error", reject);
  });
}

describe("lockNetwork() in the inference worker", () => {
  it("every way to open a connection throws", async () => {
    const r = await inLockedWorker(`
      await attempt("fetch", () => fetch("https://example.org/"));
      await attempt("WebSocket", () => new WebSocket("wss://example.org/"));
      await attempt("net.connect", () => require("node:net").connect(443, "example.org"));
      await attempt("net.createConnection", () => require("node:net").createConnection(443, "example.org"));
      await attempt("net.Socket#connect", () => new (require("node:net").Socket)().connect(443, "example.org"));
      await attempt("tls.connect", () => require("node:tls").connect(443, "example.org"));
      await attempt("http.get", () => require("node:http").get("http://example.org/"));
      await attempt("https.request", () => require("node:https").request("https://example.org/"));
      await attempt("http2.connect", () => require("node:http2").connect("https://example.org/"));
      await attempt("dgram", () => require("node:dgram").createSocket("udp4"));
      await attempt("dns.lookup", () => require("node:dns").lookup("example.org", () => {}));
      await attempt("dns.promises.lookup", () => require("node:dns").promises.lookup("example.org"));
      await attempt("import http", async () => (await import("node:http")).request("http://example.org/"));
    `);
    expect(r.fatal).toBeUndefined();
    for (const [name, outcome] of Object.entries(r)) expect(outcome, name).toMatch(/^NetworkLockedError: network access is disabled/);
    expect(Object.keys(r)).toHaveLength(13);
  });

  it("can't be undone by reassigning fetch", async () => {
    const r = await inLockedWorker(`
      await attempt("reassign", () => { globalThis.fetch = () => Promise.resolve("sneaky"); return fetch("x").then((v) => { if (v === "sneaky") throw new Error("unlocked"); }); });
    `);
    expect(r.reassign).not.toBe("allowed");
  });
});

describe("the inference code path (static checks)", () => {
  it("the worker locks the network before it loads the model or tokenizer", () => {
    const w = code("embed-worker.ts");
    expect(w.indexOf("lockNetwork();")).toBeGreaterThan(-1);
    expect(w.indexOf("lockNetwork();")).toBeLessThan(w.indexOf('import("./onnx-embedder.js")'));
    expect(w).not.toMatch(/^import .*onnx-embedder/m);
  });

  it("the model is loaded from local bytes, never a path or URL the runtime could resolve", () => {
    const o = code("onnx-embedder.ts");
    expect(o).toMatch(/InferenceSession\.create\(readFileSync\(/);
    expect(o).not.toMatch(/from_pretrained|fromPretrained|https?:|allowRemoteModels|huggingface\.co/);
    // The tokenizer gets parsed JSON, not a model id.
    expect(o).toMatch(/new TokenizerCtor\(\s*JSON\.parse\(readFileSync/);
  });

  it("no classifier inference module uses the network or HTTP clients", () => {
    for (const f of ["embed-worker.ts", "onnx-embedder.ts", "worker-embedder.ts", "embedder.ts", "service.ts", "head.ts", "heuristic.ts", "features.ts", "store.ts", "synthetic.ts", "evaluate.ts"]) {
      const c = code(f);
      expect(c, f).not.toMatch(/\bfetch\s*\(|node:https?|node:net|node:tls|node:dgram|WebSocket|XMLHttpRequest/);
    }
  });

  it("the worker gets an empty environment (no token, no DB key)", () => {
    expect(code("worker-embedder.ts")).toMatch(/env: \{\}/);
  });

  it("the only download is model-files.ts fetchModel, from the pinned base URL", () => {
    const m = code("model-files.ts");
    expect((m.match(/doFetch\(/g) ?? []).length).toBe(1);
    expect(m).toMatch(/new URL\(f\.path, m\.baseUrl\)/);
  });
});
