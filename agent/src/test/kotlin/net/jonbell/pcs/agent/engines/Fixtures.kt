package net.jonbell.pcs.agent.engines

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.math.BigDecimal
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.atomic.AtomicInteger

fun cfg(
    id: String,
    adapter: Adapter = Adapter.OPENAI_COMPAT,
    clearance: DataClass = DataClass.SYNTHETIC,
    model: String = "m-$id",
    baseUrl: String? = "http://127.0.0.1:1/v1",
    decision: String? = null,
    prices: Prices = Prices(),
    replayOf: String? = null,
    recordings: String? = null,
    command: String = "claude",
    platform: String = "api",
    structured: String = "json_schema",
    region: String? = null,
) = EngineConfig(
    id,
    adapter,
    model,
    clearance,
    decision,
    platform = platform,
    baseUrl = baseUrl,
    prices = prices,
    replayOf = replayOf,
    recordings = recordings,
    command = command,
    structured = structured,
    region = region,
)

/** The toy check's output schema: a summary and a list of notes. */
val TOY_SCHEMA: JsonObject =
    kotlinx.serialization.json.Json.parseToJsonElement(
        """{"type":"object","required":["summary","notes"],"additionalProperties":false,
            "properties":{"summary":{"type":"string","minLength":1},"notes":{"type":"array","items":{"type":"string"}}}}""",
    ) as JsonObject

fun toyOutput(summary: String = "A synthetic paper."): JsonElement =
    kotlinx.serialization.json.Json.parseToJsonElement("""{"summary":${kotlinx.serialization.json.JsonPrimitive(summary)},"notes":[]}""")

fun request(
    dataClass: DataClass = DataClass.SYNTHETIC,
    text: String = "Body text.",
    version: String = "v1",
    check: String = "toy.summary",
    system: String = "Summarise the paper.",
) = CallRequest(CheckRef(check, version), dataClass, system, listOf(Part.Text("paper", text)), TOY_SCHEMA, 512)

/** A fake adapter: counts calls and answers from a function. It is the only "model" the unit tests use. */
class ScriptedEngine(
    override val id: String,
    private val answer: (CallRequest) -> CallResult = { CallResult(it.key, Status.OK, toyOutput(), "fake-served", Usage(1000, 100)) },
) : Engine {
    val calls = AtomicInteger()
    val seen = mutableListOf<CallRequest>()
    override val caps = Caps(Structured.NATIVE, false, 100_000, false, false, ToolLoop.NONE)

    override suspend fun call(req: CallRequest): CallResult {
        calls.incrementAndGet()
        seen += req
        return answer(req).copy(key = req.key)
    }
}

class CountingStore(private val inner: ResultStore = InMemoryResultStore()) : ResultStore {
    val gets = AtomicInteger()
    val puts = AtomicInteger()

    override fun get(key: String): StoredResult? = inner.get(key).also { gets.incrementAndGet() }

    override fun put(r: StoredResult) {
        puts.incrementAndGet()
        inner.put(r)
    }

    override fun all() = inner.all()
}

/** A toy LLM check directory (prompt, schema, spec) under [root]; editing its files is a new version. */
fun toyCheckDir(root: Path, id: String = "toy.summary", prompt: String = "Summarise the paper in one sentence."): Path {
    val d = root.resolve(id)
    Files.createDirectories(d)
    Files.writeString(d.resolve("prompt.md"), prompt)
    Files.writeString(d.resolve("schema.json"), kotlinx.serialization.json.Json.encodeToString(JsonObject.serializer(), TOY_SCHEMA))
    Files.writeString(d.resolve("check.yaml"), "id: $id\ncategory: llm\n")
    return d
}

fun toyCheck(dir: Path) = DirLlmCheck(dir) { ctx -> listOf(Part.Text("paper text", ctx.x.pages.joinToString("\n") { it.text }.take(400))) }

val ZERO: BigDecimal = BigDecimal.ZERO

@Suppress("unused")
fun obj(k: String, v: String): JsonObject = buildJsonObject { put(k, v) }
