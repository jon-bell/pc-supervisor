// The inference worker's network lock (AGENTS.md rule 4: "no network access
// at inference time"). lockNetwork() runs first thing in the worker thread,
// before the model or tokenizer is loaded, and replaces every way Node code
// can open a connection with a function that throws:
//   fetch / WebSocket / EventSource globals, net.connect / createConnection /
//   Socket#connect, tls.connect, http(s).request / get, http2.connect,
//   dgram.createSocket, and the dns lookups.
// The ONNX runtime is native code that never opens sockets; the tokenizer is
// pure JS; and the model bytes are read here and handed over as a buffer, so
// neither ever sees a path or URL it could resolve remotely.
//
// Module namespaces are frozen in ESM, so the CommonJS module objects (which
// both `import` and `require` share) are patched through createRequire.

import { createRequire } from "node:module";

export class NetworkLockedError extends Error {
  constructor(what: string) {
    super(`network access is disabled in the comment classifier (${what})`);
    this.name = "NetworkLockedError";
  }
}

const req = createRequire(import.meta.url);

/** A function that throws when called, or constructed (`new WebSocket(...)`). */
function deny(what: string): () => never {
  return function denied(): never {
    throw new NetworkLockedError(what);
  };
}

let locked = false;

/** Disable network access for the rest of this thread's life. Idempotent. */
export function lockNetwork(): void {
  if (locked) return;
  locked = true;
  const g = globalThis as Record<string, unknown>;
  for (const name of ["fetch", "WebSocket", "EventSource"]) {
    Object.defineProperty(g, name, { value: deny(name), configurable: false, writable: false });
  }
  const patch = (mod: string, names: readonly string[]) => {
    const m = req(mod) as Record<string, unknown>;
    for (const n of names) m[n] = deny(`${mod}.${n}`);
  };
  patch("node:net", ["connect", "createConnection"]);
  (req("node:net") as { Socket: { prototype: Record<string, unknown> } }).Socket.prototype.connect = deny("net.Socket#connect");
  patch("node:tls", ["connect"]);
  patch("node:http", ["request", "get"]);
  patch("node:https", ["request", "get"]);
  patch("node:http2", ["connect"]);
  patch("node:dgram", ["createSocket"]);
  patch("node:dns", ["lookup", "resolve", "resolve4", "resolve6"]);
  const dnsPromises = req("node:dns").promises as Record<string, unknown>;
  for (const n of ["lookup", "resolve", "resolve4", "resolve6"]) dnsPromises[n] = deny(`dns.promises.${n}`);
}

export const networkLocked = (): boolean => locked;
