package net.jonbell.pcs.agent.engines

import com.anthropic.client.AnthropicClient
import com.anthropic.client.okhttp.AnthropicOkHttpClient
import com.anthropic.core.JsonValue
import com.anthropic.errors.AnthropicServiceException
import com.anthropic.models.messages.CacheControlEphemeral
import com.anthropic.models.messages.ContentBlockParam
import com.anthropic.models.messages.JsonOutputFormat
import com.anthropic.models.messages.Message
import com.anthropic.models.messages.MessageCreateParams
import com.anthropic.models.messages.OutputConfig
import com.anthropic.models.messages.StopReason
import com.anthropic.models.messages.TextBlockParam
import com.anthropic.models.messages.batches.BatchCreateParams
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
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
 * Message Batches (`POST /v1/messages/batches`, `GET /v1/messages/batches/{id}`, then the results as JSON
 * lines) are offered where the first-party API is the platform (`Caps.batch`): [submitBatch] sends the
 * requests with their content address as `custom_id` (64 hex characters, within the API's 64-character limit),
 * and [collectBatch] polls every [batchPollMs] until `processing_status` is `ended`, then streams the results.
 * A request that errored, was canceled or expired comes back as an ERROR result, so the dispatcher does not
 * cache it. Bedrock, Vertex and Foundry keep the per-request path.
 */
class AnthropicEngine(
    private val cfg: EngineConfig,
    private val apiKey: String? = null,
    clientOverride: AnthropicClient? = null,
    private val batchPollMs: Long = 30_000,
) : Engine {
    override val id = cfg.id
    override val caps =
        Caps(Structured.NATIVE, pdfInput = true, maxInputTokens = 200_000, batch = cfg.platform == "api", promptCache = true, toolLoop = ToolLoop.NONE)

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

    private fun userBlocks(req: CallRequest): List<ContentBlockParam> =
        buildList {
            add(ContentBlockParam.ofText(PromptRender.user(req)))
            req.parts.filterIsInstance<Part.Pdf>().forEach { p ->
                add(ContentBlockParam.ofDocument(com.anthropic.models.messages.Base64PdfSource.builder().data(p.base64).build()))
            }
        }

    private fun systemBlocks(req: CallRequest): List<TextBlockParam> =
        listOf(TextBlockParam.builder().text(req.system).cacheControl(CacheControlEphemeral.builder().build()).build())

    private fun outputConfig(req: CallRequest): OutputConfig {
        val schemaMap = JsonSchema.forProvider(req.schema).mapValues { jsonValue(it.value) }
        return OutputConfig.builder().format(
            JsonOutputFormat.builder().schema(JsonOutputFormat.Schema.builder().additionalProperties(schemaMap).build()).build(),
        ).apply {
            req.effort?.let { effort(Optional.of(OutputConfig.Effort.of(it.name.lowercase()))) }
        }.build()
    }

    internal fun params(req: CallRequest): MessageCreateParams =
        MessageCreateParams.builder()
            .model(cfg.model)
            .maxTokens(req.maxOutputTokens.toLong())
            .systemOfTextBlockParams(systemBlocks(req))
            .addUserMessageOfContentBlockParams(userBlocks(req))
            .outputConfig(outputConfig(req))
            .build()

    /** One entry of a batch: the same parameters as [params], under the request's content address. */
    internal fun batchRequest(req: CallRequest): BatchCreateParams.Request =
        BatchCreateParams.Request.builder()
            .customId(req.key)
            .params(
                BatchCreateParams.Request.Params.builder()
                    .model(cfg.model)
                    .maxTokens(req.maxOutputTokens.toLong())
                    .systemOfTextBlockParams(systemBlocks(req))
                    .addUserMessageOfContentBlockParams(userBlocks(req))
                    .outputConfig(outputConfig(req))
                    .build(),
            )
            .build()

    private fun toResult(key: String, m: Message): CallResult {
        val u = m.usage()
        val usage = Usage(u.inputTokens(), u.outputTokens(), u.cacheReadInputTokens().orElse(0), u.cacheCreationInputTokens().orElse(0))
        val text = m.content().flatMap { it.text().map { t -> t.text() }.stream().toList() }.joinToString("")
        val served = m.model().asString()
        val stop = m.stopReason().orElse(null)
        return when (stop) {
            StopReason.REFUSAL -> CallResult(key, Status.REFUSAL, servedModel = served, usage = usage, raw = text, detail = "refusal")
            StopReason.MAX_TOKENS, StopReason.MODEL_CONTEXT_WINDOW_EXCEEDED ->
                CallResult(key, Status.TRUNCATED, servedModel = served, usage = usage, raw = text, detail = "stop_reason=${stop.asString()}")
            else -> {
                val parsed = runCatching { Json.parseToJsonElement(text) }.getOrNull()
                if (parsed == null) {
                    CallResult(key, Status.SCHEMA_INVALID, servedModel = served, usage = usage, raw = text, detail = "output is not JSON")
                } else {
                    CallResult(key, Status.OK, parsed, served, usage, raw = text)
                }
            }
        }
    }

    override suspend fun call(req: CallRequest): CallResult =
        withContext(Dispatchers.IO) {
            try {
                toResult(req.key, client.messages().create(params(req)))
            } catch (e: AnthropicServiceException) {
                CallResult(req.key, Status.ERROR, detail = "HTTP ${e.statusCode()}: ${e::class.simpleName}")
            } catch (e: com.anthropic.errors.AnthropicException) {
                CallResult(req.key, Status.ERROR, detail = "${e::class.simpleName}: ${e.message?.take(200)}")
            }
        }

    override suspend fun submitBatch(reqs: List<CallRequest>): BatchHandle? {
        if (!caps.batch) return null
        require(reqs.isNotEmpty()) { "an empty batch" }
        require(reqs.size <= MAX_BATCH) { "a Message Batch holds at most $MAX_BATCH requests; split it" }
        require(reqs.all { it.key.matches(Regex("[A-Za-z0-9_-]{1,64}")) }) { "a batch request needs its content address as key (custom_id)" }
        require(reqs.map { it.key }.distinct().size == reqs.size) { "two requests with the same key in one batch" }
        return withContext(Dispatchers.IO) {
            val b = BatchCreateParams.builder()
            reqs.forEach { b.addRequest(batchRequest(it)) }
            val batch = client.messages().batches().create(b.build())
            BatchHandle(batch.id(), reqs.map { it.key })
        }
    }

    override fun collectBatch(h: BatchHandle): Flow<CallResult> =
        flow {
            var resultsUrl: String?
            while (true) {
                val b = client.messages().batches().retrieve(h.id)
                if (b.processingStatus().asString() == "ended") {
                    resultsUrl = b.resultsUrl().orElse(null)
                    break
                }
                delay(batchPollMs)
            }
            val seen = mutableSetOf<String>()
            if (resultsUrl != null) {
                client.messages().batches().resultsStreaming(h.id).use { stream ->
                    for (r in stream.stream()) {
                        val res = r.result()
                        val key = r.customId()
                        seen += key
                        emit(
                            when {
                                res.isSucceeded() -> toResult(key, res.asSucceeded().message())
                                res.isErrored() ->
                                    CallResult(
                                        key,
                                        Status.ERROR,
                                        detail = "batch request errored: ${res.asErrored().error().toString().take(160)}",
                                    )
                                res.isCanceled() -> CallResult(key, Status.ERROR, detail = "batch request canceled")
                                else -> CallResult(key, Status.ERROR, detail = "batch request expired")
                            },
                        )
                    }
                }
            }
            // A request the API reports nothing about is an error here, not silence.
            for (k in h.keys.filter { it !in seen }) emit(CallResult(k, Status.ERROR, detail = "batch ${h.id}: no result returned"))
        }.flowOn(Dispatchers.IO)

    companion object {
        const val MAX_BATCH = 100_000

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
