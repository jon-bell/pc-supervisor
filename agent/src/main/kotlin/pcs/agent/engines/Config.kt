package pcs.agent.engines

import java.math.BigDecimal
import java.math.RoundingMode

enum class Adapter(val key: String) {
    CLAUDE_CODE("claude-code"),
    ANTHROPIC("anthropic"),
    OPENAI_COMPAT("openai-compat"),
    REPLAY("replay"),
}

/** USD per million tokens. Self-hosted engines are priced at 0 plus a GPU hour rate that is not modelled here. */
data class Prices(
    val input: BigDecimal = BigDecimal.ZERO,
    val output: BigDecimal = BigDecimal.ZERO,
    val cacheRead: BigDecimal? = null,
    val cacheWrite: BigDecimal? = null,
) {
    fun cost(u: Usage): BigDecimal {
        val m = BigDecimal(1_000_000)
        val cr = cacheRead ?: input
        val cw = cacheWrite ?: input
        return (
            input *
                BigDecimal(
                    u.input,
                ) + output * BigDecimal(u.output) + cr * BigDecimal(u.cacheRead) + cw * BigDecimal(u.cacheWrite)
        ).divide(m, 8, RoundingMode.HALF_UP)
    }
}

/** One engine as declared in env (agent.md §4.3). Credentials are never part of it. */
data class EngineConfig(
    val id: String,
    val adapter: Adapter,
    val model: String,
    val clearance: DataClass,
    val clearanceDecision: String?,
    val platform: String = "api",
    val region: String? = null,
    val project: String? = null,
    val resource: String? = null,
    val baseUrl: String? = null,
    val command: String = "claude",
    val structured: String = "json_schema",
    val replayOf: String? = null,
    val recordings: String? = null,
    val apiKeyEnv: String? = null,
    val prices: Prices = Prices(),
    val concurrency: Int = 4,
    val rpm: Int? = null,
    val tpm: Int? = null,
) {
    /** Replay is transparent: its results are keyed as the engine it replays (so give it that engine's MODEL, PLATFORM, and STRUCTURED). */
    val identity: EngineIdentity
        get() = EngineIdentity(replayOf ?: id, model, "platform=$platform;structured=$structured")

    /** The one host this engine may reach, or null for an engine that makes no HTTP call of its own (replay, the CLI). */
    fun egressHost(): EgressPolicy? =
        when (adapter) {
            Adapter.REPLAY, Adapter.CLAUDE_CODE -> null
            Adapter.OPENAI_COMPAT -> EgressPolicy.forEngine(id, requireNotNull(baseUrl) { "engine $id: openai-compat needs BASE_URL" })
            Adapter.ANTHROPIC -> EgressPolicy.forEngine(id, baseUrl ?: defaultBaseUrl())
        }

    /**
     * Where each platform's SDK sends requests when no BASE_URL is set. The Bedrock, Vertex, and Foundry
     * hosts follow each provider's documented pattern and are confirmed at the maintainer's live run;
     * set BASE_URL to pin one explicitly.
     */
    fun defaultBaseUrl(): String =
        when (platform) {
            "api" -> "https://api.anthropic.com"
            "bedrock" -> "https://bedrock-mantle.${requireNotNull(region) { "engine $id: bedrock needs REGION" }}.api.aws"
            "vertex" -> {
                val r = requireNotNull(region) { "engine $id: vertex needs REGION" }
                if (r == "global") "https://aiplatform.googleapis.com" else "https://$r-aiplatform.googleapis.com"
            }
            "foundry" -> "https://${requireNotNull(resource) { "engine $id: foundry needs RESOURCE" }}.services.ai.azure.com"
            else -> error("engine $id: unknown platform $platform")
        }

    /** One line, no secrets: for `pcs agent probe`. */
    fun describe(): String =
        buildString {
            append("$id: adapter=${adapter.key} model=$model clearance=${clearance.name.lowercase()}")
            if (adapter == Adapter.ANTHROPIC) append(" platform=$platform")
            region?.let { append(" region=$it") }
            if (adapter == Adapter.OPENAI_COMPAT || (adapter == Adapter.ANTHROPIC && baseUrl != null)) append(" base_url=$baseUrl")
            egressHost()?.let { append(" egress=${it.allowedHosts.sorted()}") }
            replayOf?.let { append(" replay_of=$it") }
            append(" price_in=${prices.input} price_out=${prices.output} concurrency=$concurrency")
        }
}

class EngineConfigException(val problems: List<String>) : RuntimeException(problems.joinToString("; "))

object EngineConfigs {
    /** The ceiling a `claude-code` engine gets unless a settled decision raises it (agent.md §5.1). */
    val CLAUDE_CODE_DEFAULT_CEILING = DataClass.PUBLIC

    /**
     * Parses `PCS_ENGINES` and the `PCS_ENGINE_<id>_*` blocks. A `confidential` ceiling needs a
     * `CLEARANCE_DECISION`; a `claude-code` engine is `public` unless configured otherwise, and the
     * same rule applies to raising it. Unknown adapters and malformed numbers are reported together.
     */
    fun parse(env: Map<String, String>): List<EngineConfig> {
        val problems = mutableListOf<String>()
        val ids = env["PCS_ENGINES"]?.split(',')?.map { it.trim() }?.filter { it.isNotEmpty() }.orEmpty()
        val out = mutableListOf<EngineConfig>()
        for (id in ids) {
            fun v(k: String) = env["PCS_ENGINE_${id}_$k"]?.takeIf { it.isNotBlank() }

            fun dec(k: String): BigDecimal? =
                v(k)?.let { s -> s.toBigDecimalOrNull()?.takeIf { it.signum() >= 0 } ?: null.also { problems += "$id: $k is not a non-negative number: $s" } }

            fun int(k: String): Int? =
                v(k)?.let { s ->
                    s.toIntOrNull()?.takeIf { it > 0 } ?: null.also { problems += "$id: $k is not a positive integer: $s" }
                }
            val adapter = Adapter.entries.firstOrNull { it.key == v("ADAPTER") }
            if (adapter == null) {
                problems += "$id: ADAPTER must be one of ${Adapter.entries.map { it.key }}, got ${v("ADAPTER")}"
                continue
            }
            val clearance =
                when (val c = v("CLEARANCE")) {
                    null -> if (adapter == Adapter.CLAUDE_CODE) CLAUDE_CODE_DEFAULT_CEILING else DataClass.SYNTHETIC
                    else ->
                        DataClass.entries.firstOrNull { it.name.equals(c, ignoreCase = true) }
                            ?: DataClass.SYNTHETIC.also { problems += "$id: CLEARANCE must be synthetic, public, or confidential, got $c" }
                }
            val decision = v("CLEARANCE_DECISION")
            if (clearance == DataClass.CONFIDENTIAL &&
                decision == null
            ) {
                problems += "$id: confidential clearance needs CLEARANCE_DECISION naming a settled decision (agent.md §5.1)"
            }
            if (adapter == Adapter.CLAUDE_CODE &&
                clearance > CLAUDE_CODE_DEFAULT_CEILING &&
                decision == null
            ) {
                problems += "$id: raising a claude-code engine above public needs CLEARANCE_DECISION"
            }
            val platform = v("PLATFORM") ?: "api"
            if (adapter == Adapter.ANTHROPIC &&
                platform !in setOf("api", "bedrock", "vertex", "foundry")
            ) {
                problems += "$id: PLATFORM must be api, bedrock, vertex, or foundry, got $platform"
            }
            val model = v("MODEL")
            if (model == null && adapter != Adapter.REPLAY) problems += "$id: MODEL is required (model ids are never hard-coded)"
            if (adapter == Adapter.OPENAI_COMPAT && v("BASE_URL") == null) problems += "$id: openai-compat needs BASE_URL"
            val structured = v("STRUCTURED") ?: "json_schema"
            if (structured !in setOf("json_schema", "guided", "tool", "prompt")) problems += "$id: STRUCTURED must be json_schema, guided, tool, or prompt"
            if (adapter == Adapter.REPLAY &&
                v("REPLAY_OF") == null &&
                model == null
            ) {
                problems += "$id: replay needs REPLAY_OF (the engine whose results it serves) or MODEL"
            }
            val cfg =
                EngineConfig(
                    id = id,
                    adapter = adapter,
                    model = model ?: "",
                    clearance = clearance,
                    clearanceDecision = decision,
                    platform = platform,
                    region = v("REGION"),
                    project = v("PROJECT"),
                    resource = v("RESOURCE"),
                    baseUrl = v("BASE_URL"),
                    command = v("COMMAND") ?: "claude",
                    structured = structured,
                    replayOf = v("REPLAY_OF"),
                    recordings = v("RECORDINGS"),
                    apiKeyEnv = v("API_KEY_ENV"),
                    prices = Prices(dec("PRICE_IN") ?: BigDecimal.ZERO, dec("PRICE_OUT") ?: BigDecimal.ZERO, dec("PRICE_CACHE_READ"), dec("PRICE_CACHE_WRITE")),
                    concurrency = int("CONCURRENCY") ?: 4,
                    rpm = int("RPM"),
                    tpm = int("TPM"),
                )
            runCatching { cfg.egressHost() }.onFailure { problems += it.message ?: "$id: bad egress configuration" }
            out += cfg
        }
        if (ids.size != ids.toSet().size) problems += "PCS_ENGINES lists an engine twice"
        if (problems.isNotEmpty()) throw EngineConfigException(problems)
        return out
    }

    /** `PCS_CHECK_<check>_ENGINE=<engine id>`: production routing. */
    fun routing(env: Map<String, String>): Map<String, String> =
        env.entries.mapNotNull { (k, v) -> Regex("PCS_CHECK_(.+)_ENGINE").matchEntire(k)?.let { it.groupValues[1] to v } }.toMap()
}
