package pcs.testing

import java.util.Random

/** One arc of a flow instance: `from`, `to`, lower bound, capacity, cost. */
public data class FlowArc(val from: Int, val to: Int, val lower: Long, val cap: Long, val cost: Long)

/** A flow instance: node 0 is the source and node `n - 1` the sink unless stated. */
public data class FlowInstance(val n: Int, val s: Int, val t: Int, val arcs: List<FlowArc>) {
    /** The instance as JSON, in the field order the PHP driver (`scripts/mcmf-driver.php`) reads. */
    public fun toJson(): String =
        "{\"n\":$n,\"s\":$s,\"t\":$t,\"arcs\":[" + arcs.joinToString(",") { "[${it.from},${it.to},${it.lower},${it.cap},${it.cost}]" } + "]}"
}

/** The flows the solver returned for an instance, checked from scratch. */
public object FlowCheck {
    /**
     * Returns the problems with [flow] as a flow on [inst], or an empty list: capacity, lower
     * bound, conservation at every node but the source and sink, and that its [value] and [cost] are what it says.
     */
    public fun problems(
        inst: FlowInstance,
        flow: LongArray,
        value: Long,
        cost: Long,
    ): List<String> {
        val out = mutableListOf<String>()
        val net = LongArray(inst.n)
        var c = 0L
        inst.arcs.forEachIndexed { i, a ->
            if (flow[i] < a.lower || flow[i] > a.cap) out += "arc $i flow ${flow[i]} outside [${a.lower}, ${a.cap}]"
            net[a.from] -= flow[i]
            net[a.to] += flow[i]
            c += flow[i] * a.cost
        }
        for (v in 0 until inst.n) if (v != inst.s && v != inst.t && net[v] != 0L) out += "node $v not conserved: ${net[v]}"
        if (net[inst.t] != value || -net[inst.s] != value) out += "value $value, but net flow is ${-net[inst.s]} out of s and ${net[inst.t]} into t"
        if (c != cost) out += "cost $cost, but the flow costs $c"
        return out
    }
}

/** Random feasible instances: random paths each carry one unit, so lower bounds below that are met. */
public object FlowInstances {
    /**
     * [signedCosts] draws costs from -9..9 and keeps the graph acyclic, so there is no negative cycle;
     * otherwise costs are 0..9 (or 0..1) and extra arcs may close cycles.
     */
    public fun random(
        rnd: Random,
        signedCosts: Boolean,
    ): FlowInstance {
        val n = 4 + rnd.nextInt(10)
        val flowOn = LinkedHashMap<Pair<Int, Int>, Int>()
        repeat(1 + rnd.nextInt(6)) {
            var cur = 0
            while (cur < n - 1) {
                val nxt = if (rnd.nextInt(3) == 0) n - 1 else minOf(n - 1, cur + 1 + rnd.nextInt(3))
                flowOn.merge(cur to nxt, 1, Int::plus)
                cur = nxt
            }
        }
        repeat(rnd.nextInt(8)) {
            val a = rnd.nextInt(n - 1)
            var b = if (signedCosts) a + 1 + rnd.nextInt(n - 1 - a) else rnd.nextInt(n - 1) + 1
            if (b == a) b = n - 1
            flowOn.putIfAbsent(a to b, 0)
        }
        val scale = if (rnd.nextInt(6) == 0) 2 else 10
        val arcs =
            flowOn.map { (e, f) ->
                val cap = f + rnd.nextInt(3) + if (f == 0) 1 else 0
                val lo = if (e.first != 0 && f > 0 && rnd.nextInt(3) == 0) rnd.nextInt(f + 1) else 0
                val cost = if (signedCosts) rnd.nextInt(19) - 9 else rnd.nextInt(scale)
                FlowArc(e.first, e.second, lo.toLong(), cap.toLong(), cost.toLong())
            }
        return FlowInstance(n, 0, n - 1, arcs)
    }
}
