package pcs.agent.engines

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import java.math.BigDecimal
import java.nio.file.Files
import java.util.concurrent.TimeUnit

/**
 * Claude through the `claude` CLI in print mode (agent.md §4.3), the development engine. It uses
 * the developer's own login, so no API key is read here. A call carries only our prompt: the flags
 * switch off MCP servers, settings, tools, and session persistence, the system prompt is ours, and
 * the process runs in an empty temporary directory so no project file is picked up. The paper text goes
 * on stdin, never on the command line, where `ps` would show it. Cost, tokens, model, and latency
 * come from the JSON envelope. Its default ceiling is `public` ([EngineConfigs.CLAUDE_CODE_DEFAULT_CEILING]).
 * `effort` is not mapped: the CLI has no per-call equivalent we rely on.
 */
class ClaudeCodeEngine(private val cfg: EngineConfig, private val timeoutSeconds: Long = 600) : Engine {
    override val id = cfg.id
    override val caps = Caps(Structured.NATIVE, pdfInput = false, maxInputTokens = 200_000, batch = false, promptCache = true, toolLoop = ToolLoop.NONE)
    private val json = Json { ignoreUnknownKeys = true }

    internal fun args(req: CallRequest): List<String> =
        listOf(
            cfg.command,
            "-p",
            "--output-format",
            "json",
            "--json-schema",
            Keys.canonical(req.schema),
            "--strict-mcp-config",
            "--setting-sources",
            "",
            "--tools",
            "",
            "--system-prompt",
            req.system,
            "--no-session-persistence",
            "--model",
            cfg.model,
        )

    override suspend fun call(req: CallRequest): CallResult {
        LiveGuard.check(cfg)
        if (req.parts.any { it is Part.Pdf }) return CallResult(req.key, Status.ERROR, detail = "claude-code takes text parts only")
        return withContext(Dispatchers.IO) {
            val work = Files.createTempDirectory("pcs-claude-")
            try {
                val pb = ProcessBuilder(args(req)).directory(work.toFile()).redirectErrorStream(false)
                val p =
                    try {
                        pb.start()
                    } catch (e: java.io.IOException) {
                        return@withContext CallResult(req.key, Status.ERROR, detail = "cannot start '${cfg.command}': ${e.message?.take(120)}")
                    }
                val err = StringBuilder()
                val errT = Thread { err.append(p.errorStream.bufferedReader().readText()) }.also { it.start() }
                p.outputStream.use { it.write(PromptRender.user(req).toByteArray()) }
                val out = p.inputStream.bufferedReader().readText()
                if (!p.waitFor(timeoutSeconds, TimeUnit.SECONDS)) {
                    p.destroyForcibly()
                    return@withContext CallResult(req.key, Status.ERROR, detail = "timed out after ${timeoutSeconds}s")
                }
                errT.join()
                parse(req, out, p.exitValue())
            } finally {
                work.toFile().deleteRecursively()
            }
        }
    }

    internal fun parse(req: CallRequest, out: String, exit: Int): CallResult {
        val env =
            runCatching { json.parseToJsonElement(out.trim()).jsonObject }.getOrNull()
                ?: return CallResult(req.key, Status.ERROR, raw = out, detail = "exit $exit: output is not a JSON envelope")

        fun str(k: String) = env[k]?.takeIf { it !is JsonNull }?.jsonPrimitive?.contentOrNull
        val usageObj = env["usage"] as? JsonObject

        fun n(k: String) = usageObj?.get(k)?.jsonPrimitive?.longOrNull ?: 0L
        val usage = Usage(n("input_tokens"), n("output_tokens"), n("cache_read_input_tokens"), n("cache_creation_input_tokens"))
        val served = (env["modelUsage"] as? JsonObject)?.keys?.firstOrNull() ?: str("model") ?: ""
        val cost = env["total_cost_usd"]?.jsonPrimitive?.doubleOrNull?.let { BigDecimal.valueOf(it) } ?: BigDecimal.ZERO
        val latency = env["duration_ms"]?.jsonPrimitive?.longOrNull ?: 0L
        val stop = str("stop_reason")

        fun result(status: Status, output: JsonElement? = null, detail: String? = null) =
            CallResult(
                req.key,
                status,
                output,
                served,
                usage,
                cost,
                latency,
                1,
                out,
                detail,
            )
        if (stop == "refusal") return result(Status.REFUSAL, detail = "refusal")
        if (stop == "max_tokens") return result(Status.TRUNCATED, detail = "stop_reason=max_tokens")
        if (env["is_error"]?.jsonPrimitive?.booleanOrNull == true || exit != 0) return result(Status.ERROR, detail = "exit $exit: ${str("subtype") ?: "error"}")
        val structured = env["structured_output"]?.takeIf { it !is JsonNull }
        val value = structured ?: str("result")?.let { runCatching { json.parseToJsonElement(it) }.getOrNull() }
        return if (value == null) result(Status.SCHEMA_INVALID, detail = "no JSON in the envelope") else result(Status.OK, value)
    }
}

/** Thrown when a live engine is reached where only recorded results may be used. An [Error], so the dispatcher's catch-all does not turn it into a result: a test that gets here fails. */
class LiveCallBlocked(message: String) : Error(message)

/**
 * Tests and CI run with `pcs.noLive=true` (the Gradle test task sets it; `CI` also counts). A
 * `claude-code` engine that would start the real `claude` binary from the PATH then refuses before any
 * process starts. A command given as a path (the fake scripts of the adapter tests) is not live.
 */
object LiveGuard {
    fun blocked(): Boolean = System.getProperty("pcs.noLive") == "true" || !System.getenv("CI").isNullOrEmpty()

    fun check(cfg: EngineConfig) {
        if (blocked() && '/' !in cfg.command && '\\' !in cfg.command) {
            throw LiveCallBlocked("engine '${cfg.id}' would call the real '${cfg.command}' binary in a test or CI run; tests use replay only")
        }
    }
}
