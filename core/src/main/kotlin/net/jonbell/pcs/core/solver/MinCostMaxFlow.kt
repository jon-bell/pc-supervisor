package net.jonbell.pcs.core.solver

/**
 * Min-cost max-flow with lower bounds and signed costs (PLAN M14, spec §10.5), on primitive arrays.
 *
 * The algorithm is the primal-dual method of the Lean reference (`model/ReviewProcess/Solver.lean`):
 * Dijkstra on reduced costs, then Dinic blocking flows on the arcs of zero reduced cost. On top of that:
 *
 * - A lower bound `lo` on an arc becomes a demand at its ends, met from a super source to a super sink
 *   in a first phase that also keeps the cost minimal.
 * - An arc of negative cost starts saturated, so every residual arc has a nonnegative cost.
 * - A free arc `sink → source` turns the first phase into a min-cost feasible circulation. It is then
 *   removed, and a second phase pushes more `source → sink` flow from that circulation, which is
 *   optimal for its value. Augmenting from there keeps it optimal for every larger value.
 *
 * The result is the largest `source → sink` flow value that meets every lower bound and, among
 * the flows of that value, the cheapest. Like HotCRP's `MinCostMaxFlow`, it assumes no arc into the source
 * or out of the sink, and no lower bound on an arc out of the source. Capacities and costs are
 * `Long`s; the caller keeps sums of capacities times costs far below 2^62.
 */
public class FlowNetwork(public val nodes: Int) {
    private var m = 0
    private var from = IntArray(16)
    private var to = IntArray(16)
    private var lower = LongArray(16)
    private var cap = LongArray(16)
    private var cost = LongArray(16)

    init {
        require(nodes >= 2) { "a network needs a source and a sink" }
    }

    /** Number of arcs added so far. */
    public val arcs: Int get() = m

    /** Adds an arc and returns its index in [FlowResult.flow]. */
    public fun addArc(
        u: Int,
        v: Int,
        capacity: Long,
        cost: Long = 0,
        lower: Long = 0,
    ): Int {
        require(u in 0 until nodes && v in 0 until nodes && u != v) { "bad arc $u -> $v" }
        require(lower in 0..capacity) { "need 0 <= lower <= capacity, got $lower, $capacity" }
        if (m == from.size) {
            val n = 2 * m
            from = from.copyOf(n)
            to = to.copyOf(n)
            this.lower = this.lower.copyOf(n)
            cap = cap.copyOf(n)
            this.cost = this.cost.copyOf(n)
        }
        from[m] = u
        to[m] = v
        this.lower[m] = lower
        cap[m] = capacity
        this.cost[m] = cost
        return m++
    }

    /** Solves from [source] to [sink]. */
    public fun solve(
        source: Int,
        sink: Int,
    ): FlowResult {
        require(source in 0 until nodes && sink in 0 until nodes && source != sink) { "bad source or sink" }
        return Solver(this, source, sink).run()
    }

    private class Solver(
        val net: FlowNetwork,
        val s: Int,
        val t: Int,
    ) {
        val n = net.nodes + 2
        val sp = net.nodes
        val tp = net.nodes + 1
        val maxArcs = net.m + 1 + net.nodes

        // residual arcs: arc a and its reverse a xor 1
        val src = IntArray(2 * maxArcs)
        val dst = IntArray(2 * maxArcs)
        val res = LongArray(2 * maxArcs)
        val cst = LongArray(2 * maxArcs)
        var used = 0

        var start = IntArray(0)
        var adj = IntArray(0)
        val pot = LongArray(n)
        val dist = LongArray(n)
        val level = IntArray(n)
        val iter = IntArray(n)
        val queue = IntArray(n)
        val path = IntArray(n)
        var heapKey = LongArray(0)
        var heapNode = IntArray(0)
        var heapSize = 0

        fun add(
            u: Int,
            v: Int,
            c: Long,
            w: Long,
        ): Int {
            val a = used
            src[a] = u
            dst[a] = v
            res[a] = c
            cst[a] = w
            src[a + 1] = v
            dst[a + 1] = u
            res[a + 1] = 0
            cst[a + 1] = -w
            used += 2
            return a
        }

        fun run(): FlowResult {
            val bal = LongArray(net.nodes)
            var total = 0L
            for (i in 0 until net.m) {
                val base = if (net.cost[i] < 0) net.cap[i] else net.lower[i]
                val a = add(net.from[i], net.to[i], net.cap[i] - base, net.cost[i])
                res[a + 1] = base - net.lower[i]
                bal[net.to[i]] += base
                bal[net.from[i]] -= base
                total += net.cap[i]
            }
            val back = add(t, s, total + 1, 0)
            var need = 0L
            for (x in 0 until net.nodes) {
                if (bal[x] > 0) {
                    add(sp, x, bal[x], 0)
                    need += bal[x]
                } else if (bal[x] < 0) {
                    add(x, tp, -bal[x], 0)
                }
            }
            buildAdjacency()
            val got = primalDual(sp, tp)
            if (got != need) return FlowResult(false, 0, 0, LongArray(net.m))
            res[back] = 0
            res[back + 1] = 0
            primalDual(s, t)
            val flow = LongArray(net.m) { net.cap[it] - res[2 * it] }
            var value = 0L
            var c = 0L
            for (i in 0 until net.m) {
                if (net.from[i] == s) value += flow[i]
                if (net.to[i] == s) value -= flow[i]
                c += flow[i] * net.cost[i]
            }
            return FlowResult(true, value, c, flow)
        }

        fun buildAdjacency() {
            start = IntArray(n + 1)
            for (a in 0 until used) start[src[a] + 1]++
            for (u in 0 until n) start[u + 1] += start[u]
            val pos = start.copyOf(n)
            adj = IntArray(used)
            for (a in 0 until used) adj[pos[src[a]]++] = a
            heapKey = LongArray(used + 2)
            heapNode = IntArray(used + 2)
        }

        fun push(
            k: Long,
            v: Int,
        ) {
            var i = heapSize++
            while (i > 0) {
                val p = (i - 1) ushr 1
                if (heapKey[p] <= k) break
                heapKey[i] = heapKey[p]
                heapNode[i] = heapNode[p]
                i = p
            }
            heapKey[i] = k
            heapNode[i] = v
        }

        /** Pops the minimum into [popKey] and [popNode]. */
        var popKey = 0L
        var popNode = 0

        fun pop() {
            popKey = heapKey[0]
            popNode = heapNode[0]
            val k = heapKey[--heapSize]
            val v = heapNode[heapSize]
            var i = 0
            while (true) {
                var c = 2 * i + 1
                if (c >= heapSize) break
                if (c + 1 < heapSize && heapKey[c + 1] < heapKey[c]) c++
                if (heapKey[c] >= k) break
                heapKey[i] = heapKey[c]
                heapNode[i] = heapNode[c]
                i = c
            }
            heapKey[i] = k
            heapNode[i] = v
        }

        fun primalDual(
            from: Int,
            goal: Int,
        ): Long {
            var flow = 0L
            while (true) {
                dist.fill(INF)
                dist[from] = 0
                heapSize = 0
                push(0, from)
                while (heapSize > 0) {
                    pop()
                    val u = popNode
                    val d = popKey
                    if (d > dist[u]) continue
                    for (i in start[u] until start[u + 1]) {
                        val a = adj[i]
                        if (res[a] > 0) {
                            val v = dst[a]
                            val nd = d + cst[a] + pot[u] - pot[v]
                            if (nd < dist[v]) {
                                dist[v] = nd
                                push(nd, v)
                            }
                        }
                    }
                }
                val dt = dist[goal]
                if (dt >= INF) return flow
                for (v in 0 until n) pot[v] += minOf(dist[v], dt)
                flow += blocking(from, goal)
            }
        }

        /** Dinic on the arcs of zero reduced cost; returns the flow pushed. */
        fun blocking(
            from: Int,
            goal: Int,
        ): Long {
            var flow = 0L
            while (true) {
                level.fill(-1)
                level[from] = 0
                var qh = 0
                var qt = 0
                queue[qt++] = from
                while (qh < qt) {
                    val u = queue[qh++]
                    for (i in start[u] until start[u + 1]) {
                        val a = adj[i]
                        val v = dst[a]
                        if (res[a] > 0 && level[v] < 0 && cst[a] + pot[u] - pot[v] == 0L) {
                            level[v] = level[u] + 1
                            queue[qt++] = v
                        }
                    }
                }
                if (level[goal] < 0) return flow
                System.arraycopy(start, 0, iter, 0, n)
                var len = 0
                var u = from
                while (true) {
                    if (u == goal) {
                        var b = Long.MAX_VALUE
                        for (k in 0 until len) b = minOf(b, res[path[k]])
                        for (k in 0 until len) {
                            res[path[k]] -= b
                            res[path[k] xor 1] += b
                        }
                        flow += b
                        len = 0
                        u = from
                        continue
                    }
                    var found = -1
                    val end = start[u + 1]
                    while (iter[u] < end) {
                        val a = adj[iter[u]]
                        val v = dst[a]
                        if (res[a] > 0 && level[v] == level[u] + 1 && cst[a] + pot[u] - pot[v] == 0L) {
                            found = a
                            break
                        }
                        iter[u]++
                    }
                    if (found >= 0) {
                        path[len++] = found
                        u = dst[found]
                    } else {
                        if (u == from) break
                        level[u] = -1
                        u = src[path[--len]]
                        iter[u]++
                    }
                }
            }
        }
    }

    private companion object {
        const val INF: Long = Long.MAX_VALUE / 4
    }
}

/**
 * The result of [FlowNetwork.solve]: whether the lower bounds can be met at all, the maximum flow
 * [value], its minimum [cost], and the [flow] on each arc, indexed as [FlowNetwork.addArc] returned.
 */
public class FlowResult(
    public val feasible: Boolean,
    public val value: Long,
    public val cost: Long,
    public val flow: LongArray,
)
