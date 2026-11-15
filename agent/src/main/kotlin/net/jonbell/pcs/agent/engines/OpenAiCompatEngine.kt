package net.jonbell.pcs.agent.engines

import io.ktor.client.HttpClient
import io.ktor.client.engine.HttpClientEngine
import io.ktor.client.engine.cio.CIO
import io.ktor.client.request.header
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.contentType
import io.ktor.http.isSuccess
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import java.net.URI

/**
 * Self-hosted servers (vLLM, SGLang, llama.cpp) and other OpenAI-API hosts, over plain HTTP with
 * Ktor (agent.md §4.3). Never used for Claude. The configured base URL is the only host it may
 * reach ([EgressPolicy]), and redirects are not followed. How JSON is guaranteed is configuration:
 * `json_schema` (`response_format`), `guided` (vLLM `guided_json`), `tool` (a forced function call),
 * or `prompt` (schema in the prompt, output checked afterwards). No sampling parameters are sent.
 * PDFs are not accepted: the text parts carry the paper.
 */
class OpenAiCompatEngine(
    private val cfg: EngineConfig,
    private val apiKey: String? = null,
    httpEngine: HttpClientEngine? = null,
) : Engine {
    override val id = cfg.id
    private val base = requireNotNull(cfg.baseUrl) { "engine ${cfg.id}: openai-compat needs BASE_URL" }.trimEnd('/')
    private val policy = EgressPolicy.forEngine(cfg.id, base)
    override val caps =
        Caps(
            when (cfg.structured) {
                "json_schema" -> Structured.NATIVE
                "guided" -> Structured.GRAMMAR
                "tool" -> Structured.TOOL
                else -> Structured.PROMPT
            },
            pdfInput = false,
            maxInputTokens = 32_000,
            batch = false,
            promptCache = false,
            toolLoop = ToolLoop.NONE,
        )
    private val http: HttpClient =
        (
            httpEngine?.let {
                HttpClient(it) {
                    followRedirects = false
                    expectSuccess = false
                }
            }
                ?: HttpClient(CIO) {
                    followRedirects = false
                    expectSuccess = false
                }
        )

    private val json = Json { ignoreUnknownKeys = true }

    internal fun body(req: CallRequest): JsonObject {
        val user = PromptRender.user(req)
        val system =
            if (cfg.structured ==
                "prompt"
            ) {
                req.system + "\n\nReply with a single JSON value that validates against this JSON Schema, and nothing else:\n" +
                    Keys.canonical(req.schema)
            } else {
                req.system
            }
        return buildJsonObject {
            put("model", cfg.model)
            put("max_tokens", req.maxOutputTokens)
            put(
                "messages",
                buildJsonArray {
                    add(
                        buildJsonObject {
                            put("role", "system")
                            put("content", system)
                        },
                    )
                    add(
                        buildJsonObject {
                            put("role", "user")
                            put("content", user)
                        },
                    )
                },
            )
            when (cfg.structured) {
                "json_schema" ->
                    put(
                        "response_format",
                        buildJsonObject {
                            put("type", "json_schema")
                            put(
                                "json_schema",
                                buildJsonObject {
                                    put("name", "result")
                                    put("strict", true)
                                    put("schema", JsonSchema.forProvider(req.schema))
                                },
                            )
                        },
                    )
                "guided" -> put("guided_json", JsonSchema.forProvider(req.schema))
                "tool" -> {
                    put(
                        "tools",
                        buildJsonArray {
                            add(
                                buildJsonObject {
                                    put("type", "function")
                                    put(
                                        "function",
                                        buildJsonObject {
                                            put("name", "result")
                                            put("description", "Report the result.")
                                            put("parameters", JsonSchema.forProvider(req.schema))
                                        },
                                    )
                                },
                            )
                        },
                    )
                    put(
                        "tool_choice",
                        buildJsonObject {
                            put("type", "function")
                            put("function", buildJsonObject { put("name", "result") })
                        },
                    )
                }
            }
        }
    }

    override suspend fun call(req: CallRequest): CallResult {
        if (req.parts.any { it is Part.Pdf }) return CallResult(req.key, Status.ERROR, detail = "openai-compat takes text parts only")
        val url = "$base/chat/completions"
        policy.require(URI.create(url))
        val resp =
            try {
                http.post(url) {
                    contentType(ContentType.Application.Json)
                    apiKey?.let { header(HttpHeaders.Authorization, "Bearer $it") }
                    setBody(json.encodeToString(JsonObject.serializer(), body(req)))
                }
            } catch (e: Exception) {
                return CallResult(req.key, Status.ERROR, detail = "${e::class.simpleName}: ${e.message?.take(200)}")
            }
        val text = resp.bodyAsText()
        if (!resp.status.isSuccess()) return CallResult(req.key, Status.ERROR, raw = text, detail = "HTTP ${resp.status.value}")
        val root =
            runCatching { json.parseToJsonElement(text).jsonObject }.getOrNull()
                ?: return CallResult(req.key, Status.ERROR, raw = text, detail = "response is not a JSON object")
        val usage = root["usage"]?.let { it as? JsonObject }
        val u =
            Usage(
                usage?.get("prompt_tokens")?.jsonPrimitive?.longOrNull ?: 0,
                usage?.get("completion_tokens")?.jsonPrimitive?.longOrNull ?: 0,
                usage?.get("prompt_tokens_details")?.let { (it as? JsonObject)?.get("cached_tokens")?.jsonPrimitive?.longOrNull } ?: 0,
            )
        val served = root["model"]?.jsonPrimitive?.contentOrNull ?: ""
        val choice =
            (root["choices"] as? JsonArray)?.firstOrNull() as? JsonObject
                ?: return CallResult(req.key, Status.ERROR, servedModel = served, usage = u, raw = text, detail = "no choices")
        val msg = choice["message"] as? JsonObject
        val finish = choice["finish_reason"]?.jsonPrimitive?.contentOrNull
        val refusal = msg?.get("refusal")?.takeIf { it !is JsonNull }?.jsonPrimitive?.contentOrNull
        if (refusal != null ||
            finish == "content_filter"
        ) {
            return CallResult(req.key, Status.REFUSAL, servedModel = served, usage = u, raw = text, detail = "refusal")
        }
        if (finish == "length") return CallResult(req.key, Status.TRUNCATED, servedModel = served, usage = u, raw = text, detail = "finish_reason=length")
        val payload =
            if (cfg.structured == "tool") {
                (
                    (
                        msg?.get(
                            "tool_calls",
                        ) as? JsonArray
                    )?.firstOrNull() as? JsonObject
                )?.get("function")?.jsonObject?.get("arguments")?.jsonPrimitive?.contentOrNull
            } else {
                msg?.get("content")?.takeIf { it !is JsonNull }?.jsonPrimitive?.contentOrNull
            }
        val parsed = payload?.let { runCatching { json.parseToJsonElement(it) }.getOrNull() }
        return if (parsed ==
            null
        ) {
            CallResult(req.key, Status.SCHEMA_INVALID, servedModel = served, usage = u, raw = text, detail = "output is not JSON")
        } else {
            CallResult(req.key, Status.OK, parsed, served, u, raw = text)
        }
    }

    fun close() = http.close()
}
