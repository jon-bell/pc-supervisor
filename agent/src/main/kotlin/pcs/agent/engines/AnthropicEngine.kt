package pcs.agent.engines

import com.anthropic.client.AnthropicClient
import com.anthropic.client.okhttp.AnthropicOkHttpClient
import com.anthropic.core.JsonValue
import com.anthropic.errors.AnthropicServiceException
import com.anthropic.models.messages.CacheControlEphemeral
import com.anthropic.models.messages.ContentBlockParam
import com.anthropic.models.messages.JsonOutputFormat
import com.anthropic.models.messages.MessageCreateParams
import com.anthropic.models.messages.OutputConfig
import com.anthropic.models.messages.StopReason
import com.anthropic.models.messages.TextBlockParam
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.longOrNull
import java.util.Optional

/**
 * Claude through Anthropic's official Java SDK (agent.md §4.3): the first-party API, or Amazon
 * Bedrock (Mantle), Google Vertex, or Microsoft Foundry through the SDK's backends. The platform,
 * region, project, resource, and base URL are configuration only. Structured output is native
 * (`output_config.format`), no sampling parameters are sent, `effort` maps to `output_config.effort`,
 * and the stable system prefix carries a cache breakpoint. The client is built on first use, so
 * configuring an engine needs no credentials; the SDK reads its own from the environment unless
 * [apiKey] is given.
 *
 * Message Batches are not wired up yet ([Caps.batch] is false): see PLAN M9.
 */
class AnthropicEngine(
    private val cfg: EngineConfig,
    private val apiKey: String? = null,
    clientOverride: AnthropicClient? = null,
) : Engine {
    override val id = cfg.id
    override val caps = Caps(Structured.NATIVE, pdfInput = true, maxInputTokens = 200_000, batch = false, promptCache = true, toolLoop = ToolLoop.NONE)

    private val client: AnthropicClient by lazy { clientOverride ?: build() }

    init {
        // Fails here, not on the first call, if the configured host is not one we would allow.
        EgressPolicy.forEngine(cfg.id, cfg.baseUrl ?: cfg.defaultBaseUrl())
    }

    private fun build(): AnthropicClient {
        val b = AnthropicOkHttpClient.builder()
        when (cfg.platform) {
            "api" -> {
                if (apiKey != null) b.apiKey(apiKey) else b.fromEnv()
                cfg.baseUrl?.let { b.baseUrl(it) }
            }
            "bedrock" ->
                b.backend(
                    com.anthropic.bedrock.backends.BedrockMantleBackend.builder().fromEnv()
                        .apply {
                            cfg.region?.let { region(software.amazon.awssdk.regions.Region.of(it)) }
                            cfg.baseUrl?.let { baseUrl(it) }
                        }.build(),
                )
            "vertex" ->
                b.backend(
                    com.anthropic.vertex.backends.VertexBackend.builder().fromEnv()
                        .apply {
                            cfg.region?.let { region(it) }
                            cfg.project?.let { project(it) }
                            cfg.baseUrl?.let { baseUrl(it) }
                        }.build(),
                )
            "foundry" ->
                b.backend(
                    com.anthropic.foundry.backends.FoundryBackend.builder().fromEnv()
                        .apply {
                            cfg.resource?.let { resource(it) }
                            apiKey?.let { apiKey(it) }
                            cfg.baseUrl?.let { baseUrl(it) }
                        }.build(),
                )
            else -> error("unknown platform ${cfg.platform}")
        }
        return b.build()
    }

    internal fun params(req: CallRequest): MessageCreateParams {
        val schemaMap = req.schema.mapValues { jsonValue(it.value) }
        val blocks =
            buildList {
                add(ContentBlockParam.ofText(PromptRender.user(req)))
                req.parts.filterIsInstance<Part.Pdf>().forEach { p ->
                    add(ContentBlockParam.ofDocument(com.anthropic.models.messages.Base64PdfSource.builder().data(p.base64).build()))
                }
            }
        val oc =
            OutputConfig.builder().format(
                JsonOutputFormat.builder().schema(JsonOutputFormat.Schema.builder().additionalProperties(schemaMap).build()).build(),
            ).apply {
                req.effort?.let { effort(Optional.of(OutputConfig.Effort.of(it.name.lowercase()))) }
            }.build()
        return MessageCreateParams.builder()
            .model(cfg.model)
            .maxTokens(req.maxOutputTokens.toLong())
            .systemOfTextBlockParams(listOf(TextBlockParam.builder().text(req.system).cacheControl(CacheControlEphemeral.builder().build()).build()))
            .addUserMessageOfContentBlockParams(blocks)
            .outputConfig(oc)
            .build()
    }

    override suspend fun call(req: CallRequest): CallResult =
        withContext(Dispatchers.IO) {
            try {
                val m = client.messages().create(params(req))
                val u = m.usage()
                val usage = Usage(u.inputTokens(), u.outputTokens(), u.cacheReadInputTokens().orElse(0), u.cacheCreationInputTokens().orElse(0))
                val text = m.content().flatMap { it.text().map { t -> t.text() }.stream().toList() }.joinToString("")
                val served = m.model().asString()
                val stop = m.stopReason().orElse(null)
                when (stop) {
                    StopReason.REFUSAL -> CallResult(req.key, Status.REFUSAL, servedModel = served, usage = usage, raw = text, detail = "refusal")
                    StopReason.MAX_TOKENS, StopReason.MODEL_CONTEXT_WINDOW_EXCEEDED ->
                        CallResult(req.key, Status.TRUNCATED, servedModel = served, usage = usage, raw = text, detail = "stop_reason=${stop.asString()}")
                    else -> {
                        val parsed = runCatching { Json.parseToJsonElement(text) }.getOrNull()
                        if (parsed == null) {
                            CallResult(req.key, Status.SCHEMA_INVALID, servedModel = served, usage = usage, raw = text, detail = "output is not JSON")
                        } else {
                            CallResult(req.key, Status.OK, parsed, served, usage, raw = text)
                        }
                    }
                }
            } catch (e: AnthropicServiceException) {
                CallResult(req.key, Status.ERROR, detail = "HTTP ${e.statusCode()}: ${e::class.simpleName}")
            } catch (e: com.anthropic.errors.AnthropicException) {
                CallResult(req.key, Status.ERROR, detail = "${e::class.simpleName}: ${e.message?.take(200)}")
            }
        }

    companion object {
        internal fun jsonValue(e: JsonElement): JsonValue =
            when (e) {
                is JsonNull -> JsonValue.from(null)
                is JsonObject -> JsonValue.from(e.mapValues { jsonValue(it.value) })
                is JsonArray -> JsonValue.from(e.map { jsonValue(it) })
                is JsonPrimitive ->
                    when {
                        e.isString -> JsonValue.from(e.content)
                        e.booleanOrNull != null -> JsonValue.from(e.booleanOrNull)
                        e.longOrNull != null -> JsonValue.from(e.longOrNull)
                        else -> JsonValue.from(e.doubleOrNull)
                    }
            }
    }
}
