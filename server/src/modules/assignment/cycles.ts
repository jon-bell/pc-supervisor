// Reciprocal-cycle detection (spec §10.4 C). Nodes are people; there is an
// edge a -> r when a is an author of a paper P and r reviews P (r != a).
// A cycle a1 -> a2 -> ... -> ak -> a1 means each person reviews a paper by
// the previous one: a reciprocal arrangement worth a human look. k = 2 is the
// classic "you review mine, I review yours".
//
// Algorithm: enumerate simple cycles of length 2..maxK by a depth-bounded DFS
// from each start node s, visiting only nodes ordered after s. Each directed
// simple cycle is then found exactly once, rooted at its smallest node, so no
// dedup pass is needed. Before that the graph is pruned to nodes with both an
// incoming and an outgoing edge (repeatedly), which leaves only people who
// are both authors and reviewers; at conference scale (2,400 papers, ~10k
// review edges) that is a small graph. Work is O(n * d^(k-1)) in the pruned
// graph, and enumeration stops after `maxReport` cycles.

export interface CycleEdgeInput {
  /** Author (lowercased email). */
  from: string;
  /** Reviewer (lowercased email). */
  to: string;
  pid: number;
}

export interface Cycle {
  /** People in cycle order, starting with the smallest email. */
  nodes: string[];
  /** pids behind edge nodes[i] -> nodes[i+1] (wrapping), sorted. */
  pids: number[][];
}

export interface CycleResult {
  cycles: Cycle[];
  truncated: boolean;
  /** Nodes left after pruning (for perf diagnostics). */
  prunedNodes: number;
}

export function findCycles(edges: Iterable<CycleEdgeInput>, maxK: number, maxReport: number): CycleResult {
  // Adjacency with pid sets, by email.
  const out = new Map<string, Map<string, Set<number>>>();
  for (const e of edges) {
    if (e.from === e.to) continue;
    let m = out.get(e.from);
    if (!m) out.set(e.from, (m = new Map()));
    let s = m.get(e.to);
    if (!s) m.set(e.to, (s = new Set()));
    s.add(e.pid);
  }

  // Prune to nodes with in- and out-degree > 0, repeatedly.
  const alive = new Set<string>(out.keys());
  const indeg = new Map<string, number>();
  for (const [a, m] of out) {
    for (const b of m.keys()) indeg.set(b, (indeg.get(b) ?? 0) + 1);
    alive.add(a);
  }
  for (const b of indeg.keys()) alive.add(b);
  const outdeg = new Map<string, number>();
  for (const [a, m] of out) outdeg.set(a, m.size);
  const inn = new Map<string, Set<string>>();
  for (const [a, m] of out) for (const b of m.keys()) (inn.get(b) ?? inn.set(b, new Set()).get(b)!).add(a);
  const queue = [...alive].filter((n) => (indeg.get(n) ?? 0) === 0 || (outdeg.get(n) ?? 0) === 0);
  while (queue.length > 0) {
    const n = queue.pop()!;
    if (!alive.delete(n)) continue;
    for (const b of out.get(n)?.keys() ?? []) {
      if (!alive.has(b)) continue;
      const d = (indeg.get(b) ?? 0) - 1;
      indeg.set(b, d);
      if (d === 0) queue.push(b);
    }
    for (const a of inn.get(n) ?? []) {
      if (!alive.has(a)) continue;
      const d = (outdeg.get(a) ?? 0) - 1;
      outdeg.set(a, d);
      if (d === 0) queue.push(a);
    }
  }

  // Integer ids in email order, for deterministic output.
  const names = [...alive].sort();
  const id = new Map(names.map((n, i) => [n, i]));
  const adj: number[][] = names.map((n) =>
    [...(out.get(n)?.keys() ?? [])]
      .filter((b) => alive.has(b))
      .map((b) => id.get(b)!)
      .sort((x, y) => x - y),
  );

  const cycles: Cycle[] = [];
  let truncated = false;
  const path: number[] = [];
  const onPath = new Uint8Array(names.length);

  const emit = () => {
    const nodes = path.map((i) => names[i]!);
    const pids = nodes.map((a, i) => [...out.get(a)!.get(nodes[(i + 1) % nodes.length]!)!].sort((x, y) => x - y));
    cycles.push({ nodes, pids });
  };

  const dfs = (start: number, v: number): boolean => {
    for (const w of adj[v]!) {
      if (w === start && path.length >= 2) {
        if (cycles.length >= maxReport) {
          truncated = true;
          return false;
        }
        emit();
      } else if (w > start && !onPath[w] && path.length < maxK) {
        path.push(w);
        onPath[w] = 1;
        const go = dfs(start, w);
        onPath[w] = 0;
        path.pop();
        if (!go) return false;
      }
    }
    return true;
  };

  for (let s = 0; s < names.length; s++) {
    path.push(s);
    onPath[s] = 1;
    const go = dfs(s, s);
    onPath[s] = 0;
    path.pop();
    if (!go) break;
  }
  return { cycles, truncated, prunedNodes: names.length };
}
