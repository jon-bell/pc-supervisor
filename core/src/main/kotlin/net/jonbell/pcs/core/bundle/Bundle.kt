package net.jonbell.pcs.core.bundle

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.security.MessageDigest

/*
 * The screening bundle (agent.md §6, spec §10.3, §11): what `pcs agent bundle` writes and each
 * chair's app imports. The types live in `core` so that the app never depends on the agent; the agent
 * builds a [BundlePayload] and calls [BundleCodec].
 */

/** An anchored quotation: where it is, and the text found there. Confidential, so the bundle is encrypted. */
@Serializable
public data class BundleAnchor(
    val source: String,
    val quote: String,
    val start: Int? = null,
    val end: Int? = null,
    val page: Int? = null,
    val channel: String? = null,
    val ref: String? = null,
    val label: String = "",
)

/** One finding as the agent produced it. `status` is `verified` or `unverified`; an unverified one never reaches a person. */
@Serializable
public data class BundleFinding(
    val pid: String,
    val check: String,
    val version: String,
    val kind: String,
    val ground: String? = null,
    val severity: String,
    val status: String,
    val engine: String,
    val key: String,
    val dependsOn: List<String> = emptyList(),
    val anchors: List<BundleAnchor> = emptyList(),
    /** Explanation fields; `reason` is the engine's own, unchecked wording. */
    val fields: Map<String, String> = emptyMap(),
) {
    val verified: Boolean get() = status == VERIFIED

    public companion object {
        public const val VERIFIED: String = "verified"
        public const val UNVERIFIED: String = "unverified"
    }
}

/** A structured summary for triage: every statement anchored (agent.md §3.2, `summary`). */
@Serializable
public data class BundleSummary(
    val pid: String,
    val check: String,
    val version: String,
    val engine: String,
    val key: String,
    val items: List<BundleSummaryItem>,
    val dropped: Int = 0,
)

@Serializable
public data class BundleSummaryItem(val section: String, val text: String, val anchor: BundleAnchor)

/** One manifest row (agent.md §3.3): one judgment, its category, what it is qualified on, the decisions it needs. */
@Serializable
public data class BundleManifestRow(
    val check: String,
    val version: String,
    val category: String,
    val qualifiedOn: String,
    val decisions: List<String> = emptyList(),
    val affected: String = "",
)

/** A qualification record the run relied on (agent.md §7.4). */
@Serializable
public data class BundleQualification(
    val check: String,
    val version: String,
    val engine: String,
    val model: String,
    val variant: String = "",
    val evidence: String = "",
)

/** What the run was over: each paper's id and the SHA-256 of the PDF screened, never the PDF. */
@Serializable
public data class BundlePaper(val pid: String, val sha256: String, val dataClass: String)

@Serializable
public data class BundleManifest(
    val format: String = FORMAT,
    val createdAt: String,
    val papers: List<BundlePaper>,
    val checks: List<BundleManifestRow>,
    val qualifications: List<BundleQualification> = emptyList(),
    /** Engine ids that produced findings, with the model each served as reported. */
    val engines: Map<String, String> = emptyMap(),
) {
    public companion object {
        public const val FORMAT: String = "pcs-screening-bundle-v1"
    }
}

/** The whole plaintext content of a bundle. [canonical] fixes the order, so equal content has an equal hash. */
@Serializable
public data class BundlePayload(
    val manifest: BundleManifest,
    val findings: List<BundleFinding>,
    val summaries: List<BundleSummary> = emptyList(),
) {
    public fun canonical(): BundlePayload =
        copy(
            manifest =
                manifest.copy(
                    papers = manifest.papers.sortedBy { it.pid },
                    checks = manifest.checks.sortedBy { it.check },
                    qualifications = manifest.qualifications.sortedWith(compareBy({ it.check }, { it.version }, { it.engine }, { it.model }, { it.variant })),
                    engines = manifest.engines.toSortedMap(),
                ),
            findings =
                findings.map { f -> f.copy(fields = f.fields.toSortedMap(), dependsOn = f.dependsOn.sorted()) }
                    .sortedWith(
                        compareBy({ it.pid.padStart(12, '0') }, { it.check }, { it.ground.orEmpty() }, { it.kind }, { it.key }, { it.anchors.firstOrNull()?.quote.orEmpty() }),
                    ),
            summaries = summaries.sortedWith(compareBy({ it.pid.padStart(12, '0') }, { it.check })),
        )

    /** The bytes that are hashed and encrypted. */
    public fun bytes(): ByteArray = JSON.encodeToString(serializer(), canonical()).toByteArray(Charsets.UTF_8)

    /** The content address: SHA-256 of [bytes]. */
    public fun hash(): String = sha256Hex(bytes())

    /** Findings a person may be shown: verified, never an unverified one. */
    public val visible: List<BundleFinding> get() = findings.filter { it.verified }

    /**
     * The rows of the `screening-bundle` import kind (spec §10.3), as CSV. One row per `pid|check|ground`
     * (the import's key), so findings that share a key are merged: anchors of the verified findings are
     * concatenated, and a key with no verified finding is `unverified` with no anchors, so an unverified
     * quotation never leaves the bundle.
     */
    public fun importCsv(): String {
        val h = hash()
        val rows =
            canonical().findings.groupBy { Triple(it.pid, it.check, it.ground.orEmpty()) }.map { (k, fs) ->
                val ok = fs.filter { it.verified }
                val anchors = ok.flatMap { it.anchors }
                val engine = fs.map { it.engine }.distinct().sorted().joinToString("+")
                val version = fs.map { it.version }.distinct().sorted().joinToString("+")
                listOf(k.first, k.second, version, k.third, engine, if (ok.isEmpty()) BundleFinding.UNVERIFIED else BundleFinding.VERIFIED, h, anchorsJson(anchors))
            }
        return buildString {
            appendLine("pid,check,version,ground,engine,status,bundle_hash,anchors")
            rows.forEach { appendLine(it.joinToString(",") { c -> csv(c) }) }
        }
    }

    private fun anchorsJson(a: List<BundleAnchor>): String = if (a.isEmpty()) "" else JSON.encodeToString(kotlinx.serialization.builtins.ListSerializer(BundleAnchor.serializer()), a)

    private fun csv(s: String) = if (s.any { it == ',' || it == '"' || it == '\n' || it == '\r' }) "\"" + s.replace("\"", "\"\"") + "\"" else s

    public companion object {
        internal val JSON: Json = Json { encodeDefaults = true }

        public fun parse(bytes: ByteArray): BundlePayload = JSON.decodeFromString(serializer(), bytes.toString(Charsets.UTF_8))
    }
}

internal fun sha256Hex(b: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(b).joinToString("") { "%02x".format(it) }
