package pcs.agent.engines

import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import pcs.agent.checks.Check
import pcs.agent.checks.Checks
import pcs.agent.checks.Finding
import pcs.agent.checks.ScreenConfig
import pcs.agent.checks.ScreenContext
import pcs.agent.extract.HeuristicReferenceParser
import pcs.agent.extract.PdfExtractor
import java.math.BigDecimal
import java.nio.file.Files
import java.nio.file.Path

/** One paper going through screening: its bytes, a stable id, and its data class. */
class PaperInput(val id: String, val dataClass: DataClass, val pdf: ByteArray, val config: ScreenConfig = ScreenConfig()) {
    val sha256: String by lazy { Keys.sha256(pdf) }
}

/**
 * A check that calls an engine: one structured request per paper. M10 builds the real ones; this
 * is the shape they share, and the toy fixture in the tests uses it. Its version is the content
 * hash of its check directory ([CheckDirs]), so editing the prompt or the schema reruns this check only.
 */
interface LlmCheck {
    val id: String
    val version: String
    val system: String
    val schema: JsonObject
    val maxOutputTokens: Int get() = 2048
    val effort: Effort? get() = null

    fun parts(ctx: ScreenContext): List<Part>
}

/** An [LlmCheck] read from a check directory: `prompt.md` is the system text, `schema.json` the output schema. */
class DirLlmCheck(dir: Path, codeRoot: Path? = null, private val partsOf: (ScreenContext) -> List<Part>) : LlmCheck {
    override val id: String = dir.fileName.toString()
    override val version: String = CheckDirs.version(dir, codeRoot)
    override val system: String = Files.readString(dir.resolve("prompt.md"))
    override val schema: JsonObject = Json.parseToJsonElement(Files.readString(dir.resolve("schema.json"))) as JsonObject

    override fun parts(ctx: ScreenContext) = partsOf(ctx)

    companion object {
        /** The whole text layer as one delimited part: the default input of `pcs agent plan --llm-check`. */
        val FULL_TEXT: (ScreenContext) -> List<Part> = { ctx -> listOf(Part.Text("paper text", ctx.x.pages.joinToString("\n\n") { it.text })) }
    }
}

/** What one (check, engine, paper) cell of a plan comes to. */
data class PlanItem(
    val checkId: String,
    val checkVersion: String,
    val engineId: String,
    val paperId: String,
    val key: String,
    val cached: Boolean,
    val projectedCostUsd: BigDecimal,
)

data class Plan(val items: List<PlanItem>) {
    val cached get() = items.count { it.cached }
    val toRun get() = items.filterNot { it.cached }
    val projectedCostUsd: BigDecimal get() = toRun.fold(BigDecimal.ZERO) { a, i -> a + i.projectedCostUsd }

    fun render(): String =
        buildString {
            appendLine(
                "# pcs agent plan: ${items.size} results, $cached cached, ${toRun.size} would run, projected cost USD ${projectedCostUsd.toPlainString()}",
            )
            for (i in items.sortedWith(compareBy({ it.checkId }, { it.engineId }, { it.paperId }))) {
                appendLine(
                    "${if (i.cached) "cached " else "run    "} ${i.checkId}@${i.checkVersion} ${i.engineId} ${i.paperId} ${i.key.take(
                        12,
                    )}${if (i.cached) "" else " ~USD " + i.projectedCostUsd.toPlainString()}",
                )
            }
        }
}

/**
 * Plans and runs a set of checks over papers (agent.md §4.4). Deterministic checks run in-process
 * (engine `local`) and their findings are stored under their own keys; LLM checks go through the
 * [Dispatcher] to the engine routed to them. [localReplay] serves deterministic checks from the
 * store only, which is how CI runs every check through recorded results.
 */
class Runner(
    private val dispatcher: Dispatcher,
    private val store: ResultStore,
    private val local: List<Check> = Checks.all(),
    private val llm: List<LlmCheck> = emptyList(),
    private val routing: Map<String, String>,
    private val localReplay: Boolean = false,
    private val localVersion: (String) -> String = Checks::version,
) {
    private val findingsSer = ListSerializer(Finding.serializer())

    private fun engineFor(c: LlmCheck) = routing[c.id] ?: error("no engine routed to check ${c.id} (PCS_CHECK_${c.id}_ENGINE)")

    private fun extract(p: PaperInput): ScreenContext = ScreenContext(p.pdf, PdfExtractor(HeuristicReferenceParser).extract(p.pdf), p.config)

    private fun request(c: LlmCheck, p: PaperInput, ctx: ScreenContext) =
        CallRequest(CheckRef(c.id, c.version), p.dataClass, c.system, c.parts(ctx), c.schema, c.maxOutputTokens, c.effort)

    /** Which results are cached and what the rest would cost, without any call or spend. */
    fun plan(papers: List<PaperInput>): Plan {
        val items = mutableListOf<PlanItem>()
        for (p in papers) {
            for (c in local) {
                val v = localVersion(c.id)
                val k = Keys.localKey(c.id, v, p.sha256)
                items += PlanItem(c.id, v, LOCAL, p.id, k, store.get(k) != null, BigDecimal.ZERO)
            }
            if (llm.isNotEmpty()) {
                val ctx = extract(p)
                try {
                    for (c in llm) {
                        val e = engineFor(c)
                        val req = request(c, p, ctx)
                        val k = dispatcher.keyFor(e, req)
                        val hit = dispatcher.cached(k)
                        items += PlanItem(c.id, c.version, e, p.id, k, hit != null, if (hit != null) BigDecimal.ZERO else project(e, req))
                    }
                } finally {
                    ctx.close()
                }
            }
        }
        return Plan(items)
    }

    /**
     * The projected cost of a call that is not cached: the mean usage recorded for the same check on
     * the same engine if there is any, otherwise an estimate (4 characters per input token; half the
     * output bound), both priced from the configured prices.
     */
    private fun project(engineId: String, req: CallRequest): BigDecimal {
        val prices = dispatcher.config(engineId).prices
        val seen =
            dispatcher.stored().filter {
                it.checkId == req.check.id && it.engineId == engineId && it.result?.status == Status.OK
            }.mapNotNull { it.result?.usage }
        val usage =
            if (seen.isNotEmpty()) {
                Usage(
                    seen.sumOf { it.input } / seen.size,
                    seen.sumOf { it.output } / seen.size,
                    seen.sumOf { it.cacheRead } / seen.size,
                    seen.sumOf { it.cacheWrite } / seen.size,
                )
            } else {
                val chars = req.system.length + PromptRender.user(req).length + Keys.canonical(req.schema).length
                Usage(input = (chars / 4).toLong(), output = (req.maxOutputTokens / 2).toLong())
            }
        return prices.cost(usage)
    }

    class Outcome(
        val paperId: String,
        val checkId: String,
        val engineId: String,
        val cached: Boolean,
        val findings: List<Finding>? = null,
        val result: CallResult? = null,
    )

    suspend fun run(papers: List<PaperInput>): List<Outcome> {
        val out = mutableListOf<Outcome>()
        for (p in papers) {
            var ctx: ScreenContext? = null
            try {
                for (c in local) {
                    val v = localVersion(c.id)
                    val k = Keys.localKey(c.id, v, p.sha256)
                    val hit = store.get(k)
                    if (hit?.findings != null) {
                        out += Outcome(p.id, c.id, LOCAL, true, Json.decodeFromJsonElement(findingsSer, hit.findings))
                        continue
                    }
                    check(!localReplay) { "replay: no recorded result for ${c.id}@$v on ${p.id}" }
                    val x = ctx ?: extract(p).also { ctx = it }
                    val fs = c.run(x)
                    store.put(StoredResult(k, c.id, v, LOCAL, p.id, p.dataClass, findings = Json.encodeToJsonElement(findingsSer, fs)))
                    out += Outcome(p.id, c.id, LOCAL, false, fs)
                }
                for (c in llm) {
                    val x = ctx ?: extract(p).also { ctx = it }
                    val e = engineFor(c)
                    val d = dispatcher.call(e, request(c, p, x), p.id)
                    out += Outcome(p.id, c.id, e, d.cached, result = d.result)
                }
            } finally {
                ctx?.close()
            }
        }
        return out
    }

    companion object {
        const val LOCAL = "local"
    }
}
