package net.jonbell.pcs.testing

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.nio.file.Files
import java.nio.file.Path

/**
 * T9 measurements (PLAN §A5, M19): a budget is judged by the 95th percentile of n runs (nearest rank) and a percentile-bootstrap 95%
 * confidence interval for it. Everything is integer milliseconds and a fixed SplitMix64 stream, so `lake exe check-evidence` re-derives
 * the percentile, the interval and the verdict from the raw samples without trusting this code.
 *
 * What the test can and cannot show: a clean sample of n runs supports "fewer than 5% of runs exceed the budget" at 1 - 0.95^n confidence, which
 * is 40% for 10 runs and 95% for 59 (owner's ruling 2026-11-15: the nightly job takes 59 runs per budget, `PCS_SCALE_RUNS=59`, and
 * `docs/scale-budgets.json` makes 59 the minimum `check-evidence` accepts). The record says so.
 */
public object Measurements {
    private val PRETTY = Json { prettyPrint = true }

    public const val RESAMPLES: Int = 10_000
    public const val SEED: Long = 0x5EED_0019L

    public class SplitMix64(private var s: Long) {
        public fun next(): Long {
            s += -0x61c8864680b583ebL
            var z = s
            z = (z xor (z ushr 30)) * -0x40a7b892e31b1a47L
            z = (z xor (z ushr 27)) * -0x6b2fb644ecceee15L
            return z xor (z ushr 31)
        }

        public fun below(n: Int): Int = java.lang.Long.remainderUnsigned(next(), n.toLong()).toInt()
    }

    /** Nearest rank: the ceil(q n)-th smallest, with q in percent. */
    public fun rank(sorted: List<Long>, percent: Int): Long = sorted[(percent * sorted.size + 99) / 100 - 1]

    public fun p95(samples: List<Long>): Long = rank(samples.sorted(), 95)

    /** The 2.5th and 97.5th percentiles of the bootstrap distribution of the nearest-rank 95th percentile. */
    public fun bootstrapCi(runs: List<Long>): Pair<Long, Long> {
        require(runs.isNotEmpty())
        val samples = runs.sorted() // the order of the runs does not matter
        val rng = SplitMix64(SEED)
        val n = samples.size
        val stats = LongArray(RESAMPLES)
        for (b in 0 until RESAMPLES) {
            val r = ArrayList<Long>(n)
            repeat(n) { r += samples[rng.below(n)] }
            stats[b] = p95(r)
        }
        stats.sort()
        return stats[RESAMPLES * 25 / 1000] to stats[(RESAMPLES * 975 + 999) / 1000 - 1]
    }

    public data class Budget(val ms: Long, val what: String)

    public class Budgets(public val runs: Int, private val map: Map<String, Budget>) {
        public operator fun get(metric: String): Budget = map[metric] ?: error("no budget for $metric in docs/scale-budgets.json")

        public val all: Map<String, Budget> get() = map
    }

    public fun budgets(repoRoot: Path): Budgets {
        val o = Json.parseToJsonElement(Files.readString(repoRoot.resolve("docs/scale-budgets.json"))).jsonObject
        val b =
            o["budgets"]!!.jsonObject.mapValues { (_, v) ->
                Budget(v.jsonObject["ms"]!!.jsonPrimitive.content.toLong(), v.jsonObject["what"]!!.jsonPrimitive.content)
            }
        return Budgets(o["runs"]!!.jsonPrimitive.int, b)
    }

    public fun environment(extra: Map<String, String> = emptyMap()): JsonObject =
        buildJsonObject {
            put("os", System.getProperty("os.name") + " " + System.getProperty("os.version"))
            put("cpus", Runtime.getRuntime().availableProcessors())
            put("jvm", System.getProperty("java.vm.name") + " " + System.getProperty("java.version"))
            put("jvmMaxHeapMb", Runtime.getRuntime().maxMemory() / (1024 * 1024))
            put("hotcrp", "docker compose harness on localhost (hotcrp + mariadb 10.11, tmpfs data)")
            put("ci", System.getenv("GITHUB_ACTIONS") == "true")
            put("runner", System.getenv("RUNNER_NAME") ?: "local")
            extra.forEach { (k, v) -> put(k, v) }
        }

    /**
     * Writes `<dir>/<metric>.json`, an evidence record of kind `measurement`. [workload] says what was run, [claims] what it is evidence for.
     */
    public fun record(
        dir: Path,
        metric: String,
        budget: Budget,
        samples: List<Long>,
        requiredRuns: Int,
        workload: JsonObject,
        claims: List<String>,
        environment: JsonObject,
        provenance: JsonObject,
    ): JsonObject {
        val p = p95(samples)
        val (lo, hi) = bootstrapCi(samples)
        val within = p <= budget.ms && hi <= budget.ms
        val rec =
            buildJsonObject {
                put("kind", "measurement")
                put("family", "T9")
                put("metric", metric)
                put("claims", JsonArray(claims.map { JsonPrimitive(it) }))
                put("unit", "ms")
                put("budgetMs", budget.ms)
                put("budget", budget.what)
                put("requiredRuns", requiredRuns)
                put("samplesMs", JsonArray(samples.map { JsonPrimitive(it) }))
                put(
                    "statistic",
                    buildJsonObject {
                        put("name", "95th percentile, nearest rank, with a percentile-bootstrap 95% confidence interval")
                        put("percent", 95)
                        put("resamples", RESAMPLES)
                        put("rng", "splitmix64 seed $SEED, index = unsigned(next) mod n")
                        put("p95Ms", p)
                        put("ciMs", JsonArray(listOf(JsonPrimitive(lo), JsonPrimitive(hi))))
                        put("median", samples.sorted()[samples.size / 2])
                        put("min", samples.min())
                        put("max", samples.max())
                        put(
                            "limits",
                            "With ${samples.size} runs the nearest-rank 95th percentile is " +
                                (if (samples.size < 20) "the slowest run" else "near the slowest run") +
                                ", and the bootstrap interval cannot exceed the slowest run. A clean sample shows P(run over budget) < 5% only at " +
                                "${"%.0f".format(100 * (1 - Math.pow(0.95, samples.size.toDouble())))}% confidence (59 clean runs for 95%).",
                        )
                    },
                )
                put("verdict", buildJsonObject { put("withinBudget", within) })
                put("workload", workload)
                put("environment", environment)
                put("provenance", provenance)
            }
        Files.createDirectories(dir)
        Files.writeString(dir.resolve("$metric.json"), PRETTY.encodeToString(JsonObject.serializer(), rec) + "\n")
        return rec
    }

    public fun provenance(repo: Path): JsonObject =
        buildJsonObject {
            fun sh(vararg cmd: String) =
                runCatching {
                    ProcessBuilder(*cmd).directory(repo.toFile()).redirectErrorStream(true).start().let { p ->
                        p.inputStream.bufferedReader().readText().trim().also { p.waitFor() }
                    }
                }.getOrDefault("unknown")
            put("appBuild", sh("git", "rev-parse", "HEAD") + "+core")
            put("modelCommit", sh("git", "log", "-1", "--format=%H", "--", "model"))
            put(
                "hotcrpRef",
                System.getenv("HOTCRP_REF") ?: Regex("""ARG HOTCRP_REF=(\S+)""").find(Files.readString(repo.resolve("hotcrp/Dockerfile")))?.groupValues?.get(1)
                    ?: "unknown",
            )
            put("generatorSeed", JsonPrimitive(20301))
        }

    public fun jsonOf(m: Map<String, Any?>): JsonObject = JsonObject(m.mapValues { toJson(it.value) })

    private fun toJson(v: Any?): JsonElement =
        when (v) {
            null -> JsonNull
            is Number -> JsonPrimitive(v)
            is Boolean -> JsonPrimitive(v)
            is String -> JsonPrimitive(v)
            is Map<*, *> -> JsonObject(v.entries.associate { it.key.toString() to toJson(it.value) })
            is List<*> -> JsonArray(v.map { toJson(it) })
            else -> JsonPrimitive(v.toString())
        }
}
