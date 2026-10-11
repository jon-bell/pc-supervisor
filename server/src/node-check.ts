// Refuses to run on a Node.js too old for our native modules, for the `pcs`
// CLI only (cli.ts). The SQLCipher driver (better-sqlite3-multiple-ciphers) is
// built with NAPI_VERSION=10; on a Node with Node-API 9 (e.g. 22.13) it
// segfaults the moment a database opens, with no error message.

/** The Node-API version our native modules are built against (first in Node 22.14). */
export const REQUIRED_NAPI = 10;

/** A one-line problem if this Node is too old, else undefined. */
export function nodeProblem(versions: NodeJS.ProcessVersions = process.versions): string | undefined {
  const napi = Number(versions.napi);
  if (napi >= REQUIRED_NAPI) return undefined;
  return (
    `pcs: Node.js ${versions.node} provides Node-API ${versions.napi ?? "unknown"}, but pcs needs Node-API ${REQUIRED_NAPI} ` +
    `(Node >= 22.14); the SQLite driver crashes on older versions. Upgrade Node (e.g. \`nvm install 22\`).`
  );
}
