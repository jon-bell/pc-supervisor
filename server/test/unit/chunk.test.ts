import { describe, expect, it } from "vitest";
import { pidChunks } from "../../src/hotcrp/chunk.js";

describe("pidChunks", () => {
  it("chunks sorted, de-duplicated pids into ranges", () => {
    expect(pidChunks([5, 1, 2, 3, 3, 4], 2)).toEqual([
      { q: "1-2", pids: [1, 2] },
      { q: "3-4", pids: [3, 4] },
      { q: "5", pids: [5] },
    ]);
  });

  it("never overlaps across gaps", () => {
    const chunks = pidChunks([1, 2, 10, 11, 12, 40], 3);
    expect(chunks.map((c) => c.q)).toEqual(["1-10", "11-40"]);
  });

  it("scales to 2,400 papers in 12 chunks of 200", () => {
    const chunks = pidChunks(Array.from({ length: 2400 }, (_, i) => i + 1), 200);
    expect(chunks).toHaveLength(12);
    expect(chunks[11]!.q).toBe("2201-2400");
  });

  it("handles empty input and rejects bad arguments", () => {
    expect(pidChunks([], 200)).toEqual([]);
    expect(() => pidChunks([1], 0)).toThrow(RangeError);
    expect(() => pidChunks([0], 10)).toThrow(RangeError);
  });
});
