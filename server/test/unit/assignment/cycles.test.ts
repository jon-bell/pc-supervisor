import { describe, expect, it } from "vitest";
import { findCycles, type CycleEdgeInput } from "../../../src/modules/assignment/cycles.js";

const E = (from: string, to: string, pid: number): CycleEdgeInput => ({ from, to, pid });

describe("findCycles", () => {
  it("finds a 2-cycle once, rooted at the smallest node, with the papers per edge", () => {
    const r = findCycles([E("b", "a", 1), E("a", "b", 2), E("a", "b", 3)], 3, 100);
    expect(r.cycles).toEqual([{ nodes: ["a", "b"], pids: [[2, 3], [1]] }]);
    expect(r.truncated).toBe(false);
  });

  it("finds a 3-cycle once and ignores acyclic edges and self-loops", () => {
    const r = findCycles([E("c", "a", 3), E("a", "b", 1), E("b", "c", 2), E("x", "a", 9), E("a", "a", 4), E("b", "y", 5)], 3, 100);
    expect(r.cycles).toEqual([{ nodes: ["a", "b", "c"], pids: [[1], [2], [3]] }]);
    expect(r.prunedNodes).toBe(3);
  });

  it("respects maxK", () => {
    const four = [E("a", "b", 1), E("b", "c", 2), E("c", "d", 3), E("d", "a", 4)];
    expect(findCycles(four, 3, 100).cycles).toEqual([]);
    expect(findCycles(four, 4, 100).cycles.map((c) => c.nodes)).toEqual([["a", "b", "c", "d"]]);
    const tri = [E("a", "b", 1), E("b", "c", 2), E("c", "a", 3)];
    expect(findCycles(tri, 2, 100).cycles).toEqual([]);
  });

  it("reports both directions of a triangle as distinct cycles, and each 2-cycle in it", () => {
    const xs = ["a", "b", "c"];
    const edges = xs.flatMap((u, i) => xs.filter((v) => v !== u).map((v, j) => E(u, v, i * 10 + j)));
    const r = findCycles(edges, 3, 100);
    expect(r.cycles.map((c) => c.nodes.join(">")).sort()).toEqual(["a>b", "a>b>c", "a>c", "a>c>b", "b>c"]);
  });

  it("stops at maxReport and says so", () => {
    const edges = ["b", "c", "d", "e"].flatMap((x, i) => [E("a", x, i), E(x, "a", 10 + i)]);
    const r = findCycles(edges, 2, 3);
    expect(r.cycles).toHaveLength(3);
    expect(r.truncated).toBe(true);
    expect(findCycles(edges, 2, 4).truncated).toBe(false);
  });

  it("scales: 2,400 papers, ~10k review edges, 1,000 author-reviewers, k=3", () => {
    // Deterministic LCG; synthetic emails only.
    let seed = 12345;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
    const reviewers = Array.from({ length: 1200 }, (_, i) => `r${i}@example.org`);
    const edges: CycleEdgeInput[] = [];
    let reviewEdges = 0;
    for (let pid = 1; pid <= 2400; pid++) {
      const authors = [`au${pid}@example.org`, reviewers[rnd(1000)]!, `au${pid}b@example.org`, reviewers[rnd(1000)]!];
      const revs = new Set<string>();
      while (revs.size < 4) revs.add(reviewers[rnd(1200)]!);
      reviewEdges += revs.size;
      for (const a of authors) for (const r of revs) edges.push(E(a, r, pid));
    }
    expect(reviewEdges).toBeGreaterThanOrEqual(9600);
    const t0 = performance.now();
    const r = findCycles(edges, 3, 1_000_000);
    const ms = performance.now() - t0;
    expect(r.cycles.length).toBeGreaterThan(0);
    // Every reported cycle is simple and canonical (smallest node first).
    for (const c of r.cycles.slice(0, 2000)) {
      expect(new Set(c.nodes).size).toBe(c.nodes.length);
      expect([...c.nodes].sort()[0]).toBe(c.nodes[0]);
    }
    expect(new Set(r.cycles.map((c) => c.nodes.join(">"))).size).toBe(r.cycles.length);
    expect(ms).toBeLessThan(5000);
  });
});
