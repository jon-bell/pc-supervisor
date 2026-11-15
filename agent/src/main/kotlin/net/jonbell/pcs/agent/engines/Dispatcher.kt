package net.jonbell.pcs.agent.engines

import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlin.time.TimeSource

/** Thrown before any I/O: the engine's configured ceiling is below the request's data class (agent.md §5.1). */
class ClearanceRefused(val engineId: String, val ceiling: DataClass, val requested: DataClass) :
    RuntimeException("engine '$engineId' is cleared for ${ceiling.name.lowercase()} data; refusing a call carrying ${requested.name.lowercase()} data")

/** Thrown before any I/O: a guard (the boundary observer) rejected the request. */
class RequestRejected(val engineId: String, why: String) : RuntimeException("request to engine '$engineId' rejected: $why")

/** Thrown before any I/O: a result came back for a key that was not asked for, or a batch lost one. */
class BatchProblem(message: String) : RuntimeException(message)

class UnknownEngine(id: String) : RuntimeException("no engine '$id' is configured")

/** Looks at the exact text an engine would receive. Returns a reason to reject, or null to allow. */
fun interface RequestGuard {
    fun inspect(req: CallRequest): String?

    companion object {
        /**
         * The boundary observer for prop:C1: none of [canaries] (strings planted in review or comment
         * text by the tests) may appear anywhere in a request. The reason never repeats the canary.
         */
        fun canaries(canaries: Set<String>) =
            RequestGuard { req ->
                val wire =
                    req.system + "\n" + PromptRender.user(req) + "\n" + Keys.canonical(req.schema) + "\n" +
                        req.parts.joinToString("\n") { (it as? Part.Pdf)?.base64.orEmpty() }
                if (canaries.any { it.isNotEmpty() && it in wire }) "a protected string appears in the request" else null
            }
    }
}

/** A registered engine: the adapter and the configuration that decides what it may see. */
class Registered(val config: EngineConfig, val engine: Engine)

data class Dispatched(val result: CallResult, val cached: Boolean)

/**
 * The only way to reach an engine (agent.md §5.1, AGENTS.md rule 4). The clearance comes from
 * configuration, never from the adapter, and is checked before the store is read, a guard runs, or
 * the adapter is touched, so a new adapter cannot skip it. Results are validated against the
 * request's schema here too, so every adapter returns the same shape or a SCHEMA_INVALID.
 */
class Dispatcher(
    engines: List<Registered>,
    private val store: ResultStore? = null,
    private val guards: List<RequestGuard> = emptyList(),
    /** Production runs set this: a confidential request to an unqualified (check, engine) pair is refused (agent.md §7.4). */
    private val gate: net.jonbell.pcs.agent.qualify.QualificationGate? = null,
) {
    private val byId = engines.associateBy { it.config.id }
    private val gates = engines.associate { it.config.id to Semaphore(it.config.concurrency) }

    init {
        require(byId.size == engines.size) { "two engines with the same id" }
    }

    fun config(engineId: String): EngineConfig = (byId[engineId] ?: throw UnknownEngine(engineId)).config

    /** The stored result for a key, if the dispatcher's store has one. No call, no spend. */
    fun cached(key: String): CallResult? = store?.get(key)?.result

    /** Everything the dispatcher's store holds, for projecting cost from recorded usage. */
    fun stored(): List<StoredResult> = store?.all().orEmpty()

    fun keyFor(engineId: String, req: CallRequest): String = Keys.key(req, config(engineId).identity)

    /** The refusals that apply before anything else happens: clearance first, then qualification, then the guards. */
    private fun admit(reg: Registered, req: CallRequest) {
        val cfg = reg.config
        if (cfg.clearance < req.dataClass) throw ClearanceRefused(cfg.id, cfg.clearance, req.dataClass)
        if (req.dataClass == DataClass.CONFIDENTIAL) {
            gate?.refusal(req, cfg.identity)?.let { throw net.jonbell.pcs.agent.qualify.Unqualified(req.check.id, cfg.id, it) }
        }
        for (g in guards) g.inspect(req)?.let { throw RequestRejected(cfg.id, it) }
    }

    /** Cost, schema validation and the store, the same for a call and for a batched result. */
    private fun finish(cfg: EngineConfig, req: CallRequest, key: String, raw: CallResult, paperId: String, latencyFallback: Long): Dispatched {
        var res = raw.copy(key = key, latencyMs = raw.latencyMs.takeIf { it > 0 } ?: latencyFallback)
        if (res.costUsd.signum() == 0) res = res.copy(costUsd = cfg.prices.cost(res.usage))
        if (res.status == Status.OK) {
            val out = res.output
            val errs = if (out == null) listOf("no output") else JsonSchema.validate(req.schema, out)
            if (errs.isNotEmpty()) res = res.copy(status = Status.SCHEMA_INVALID, detail = errs.take(5).joinToString("; "))
        }
        // Only definitive outcomes are cached; a transport error or a truncation is worth retrying.
        if (store != null && (res.status == Status.OK || res.status == Status.REFUSAL)) {
            store.put(StoredResult(key, req.check.id, req.check.version, cfg.id, paperId, req.dataClass, res))
        }
        return Dispatched(res, cached = false)
    }

    suspend fun call(engineId: String, req: CallRequest, paperId: String = ""): Dispatched {
        val reg = byId[engineId] ?: throw UnknownEngine(engineId)
        val cfg = reg.config
        admit(reg, req)
        val key = Keys.key(req, cfg.identity)
        store?.get(key)?.result?.let { return Dispatched(it, cached = true) }
        val keyed = req.copy(key = key)
        val t0 = TimeSource.Monotonic.markNow()
        val raw =
            gates.getValue(engineId).withPermit {
                try {
                    reg.engine.call(keyed)
                } catch (e: kotlinx.coroutines.CancellationException) {
                    throw e
                } catch (e: Exception) {
                    CallResult(key, Status.ERROR, detail = "${e::class.simpleName}: ${e.message?.take(200)}")
                }
            }
        return finish(cfg, req, key, raw, paperId, t0.elapsedNow().inWholeMilliseconds)
    }

    /**
     * Many requests to one engine as one batch when the engine has batch support (`Caps.batch`), otherwise one
     * call each. Every request passes the same refusals as [call] before anything is submitted, so a batch cannot
     * carry a request a single call would be refused; stored results are served without being resubmitted, and
     * results are validated and stored as for a call. The answers come back in the order of [items].
     */
    suspend fun callBatch(engineId: String, items: List<Pair<CallRequest, String>>): List<Dispatched> {
        val reg = byId[engineId] ?: throw UnknownEngine(engineId)
        val cfg = reg.config
        for ((req, _) in items) admit(reg, req)
        val keys = items.map { (req, _) -> Keys.key(req, cfg.identity) }
        val out = arrayOfNulls<Dispatched>(items.size)
        val pending = mutableListOf<Int>()
        for (i in items.indices) {
            val hit = store?.get(keys[i])?.result
            if (hit != null) out[i] = Dispatched(hit, cached = true) else pending += i
        }
        if (pending.isNotEmpty()) {
            val distinct = pending.distinctBy { keys[it] }
            val handle = if (reg.engine.caps.batch) reg.engine.submitBatch(distinct.map { items[it].first.copy(key = keys[it]) }) else null
            if (handle == null) {
                for (i in distinct) out[i] = call(engineId, items[i].first, items[i].second)
            } else {
                val t0 = TimeSource.Monotonic.markNow()
                val got = reg.engine.collectBatch(handle).toList().associateBy { it.key }
                val extra = got.keys - distinct.map { keys[it] }.toSet()
                if (extra.isNotEmpty()) throw BatchProblem("batch ${handle.id} returned ${extra.size} result(s) for keys that were not submitted")
                for (i in distinct) {
                    val r = got[keys[i]] ?: CallResult(keys[i], Status.ERROR, detail = "batch ${handle.id}: no result for this request")
                    out[i] = finish(cfg, items[i].first, keys[i], r, items[i].second, t0.elapsedNow().inWholeMilliseconds)
                }
            }
            for (i in pending) if (out[i] == null) out[i] = out[distinct.first { keys[it] == keys[i] }]
        }
        return out.map { it!! }
    }
}
