import { describe, expect, it } from "vitest";
import { nodeProblem } from "../../src/node-check.js";

const v = (node: string, napi: string | undefined) => ({ ...process.versions, node, napi }) as NodeJS.ProcessVersions;

describe("nodeProblem", () => {
  it("accepts Node-API 10 and later", () => {
    expect(nodeProblem(v("22.14.0", "10"))).toBeUndefined();
    expect(nodeProblem(v("25.6.1", "10"))).toBeUndefined();
    expect(nodeProblem(v("26.0.0", "11"))).toBeUndefined();
  });

  it("names the version and the fix when Node-API is older", () => {
    expect(nodeProblem(v("22.13.0", "9"))).toBe(
      "pcs: Node.js 22.13.0 provides Node-API 9, but pcs needs Node-API 10 (Node >= 22.14); " +
        "the SQLite driver crashes on older versions. Upgrade Node (e.g. `nvm install 22`).",
    );
  });

  it("rejects a Node that reports no Node-API version", () => {
    expect(nodeProblem(v("22.0.0", undefined))).toMatch(/provides Node-API unknown/);
  });
});
