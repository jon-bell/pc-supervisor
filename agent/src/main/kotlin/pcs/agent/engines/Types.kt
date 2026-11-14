package pcs.agent.engines

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import java.math.BigDecimal

/*
 * The engine interface (agent.md §4.2). An engine turns one structured request into one result.
 * Engines never decide whether they may see a request: that is the dispatcher's job (§5.1).
 */

/** Ordered by sensitivity: an engine cleared for a class is cleared for every class before it. */
enum class DataClass { SYNTHETIC, PUBLIC, CONFIDENTIAL }

/** How an engine guarantees JSON: natively, by grammar, through a tool call, or only by asking. */
enum class Structured { NATIVE, GRAMMAR, TOOL, PROMPT }

enum class ToolLoop { NONE, OWN, HARNESS }

enum class Effort { LOW, MEDIUM, HIGH }

enum class Status { OK, SCHEMA_INVALID, REFUSAL, TRUNCATED, ERROR }

data class Caps(
    val structured: Structured,
    val pdfInput: Boolean,
    val maxInputTokens: Int,
    val batch: Boolean,
    val promptCache: Boolean,
    val toolLoop: ToolLoop,
)

@Serializable
data class CheckRef(val id: String, val version: String)

/** What a call may carry: delimited text (with its anchors), a PDF, or reference metadata. Never review or comment text. */
@Serializable
sealed interface Part {
    @Serializable
    data class Text(val label: String, val text: String) : Part

    /** A PDF, base64 encoded so the request is plain JSON. */
    @Serializable
    data class Pdf(val label: String, val base64: String) : Part

    @Serializable
    data class References(val label: String, val records: List<JsonObject>) : Part
}

/**
 * One structured call. [key] is the content address (§4.4); the dispatcher computes it for the
 * engine that will serve the call, so a caller leaves it empty.
 */
data class CallRequest(
    val check: CheckRef,
    val dataClass: DataClass,
    val system: String,
    val parts: List<Part>,
    val schema: JsonObject,
    val maxOutputTokens: Int,
    val effort: Effort? = null,
    /** Versions of the decisions the check depends on (agent.md §3.3); a settled decision that changes reruns the check. */
    val decisionVersions: List<String> = emptyList(),
    /** Free-form variant label (PDF input vs text, abstract-only vs full text...). */
    val variant: String = "",
    val key: String = "",
)

@Serializable
data class Usage(val input: Long = 0, val output: Long = 0, val cacheRead: Long = 0, val cacheWrite: Long = 0)

object BigDecimalSerializer : KSerializer<BigDecimal> {
    override val descriptor = PrimitiveSerialDescriptor("BigDecimal", PrimitiveKind.STRING)

    override fun serialize(encoder: Encoder, value: BigDecimal) = encoder.encodeString(value.toPlainString())

    override fun deserialize(decoder: Decoder): BigDecimal = BigDecimal(decoder.decodeString())
}

@Serializable
data class CallResult(
    val key: String,
    val status: Status,
    /** Validated against the request's schema whenever [status] is OK. */
    val output: JsonElement? = null,
    /** As reported by the provider, not as requested. */
    val servedModel: String = "",
    val usage: Usage = Usage(),
    @Serializable(with = BigDecimalSerializer::class) val costUsd: BigDecimal = BigDecimal.ZERO,
    val latencyMs: Long = 0,
    val attempts: Int = 1,
    /** The provider's body. Stored with the result, never logged. */
    val raw: String = "",
    /** Why the status is not OK (a refusal category, the schema error, the transport error). Never contains paper text. */
    val detail: String? = null,
)

data class BatchHandle(val id: String, val keys: List<String>)

interface Engine {
    val id: String
    val caps: Caps

    suspend fun call(req: CallRequest): CallResult

    /** Null: this engine has no batch support. */
    suspend fun submitBatch(reqs: List<CallRequest>): BatchHandle? = null

    fun collectBatch(h: BatchHandle): Flow<CallResult> = emptyFlow()
}
