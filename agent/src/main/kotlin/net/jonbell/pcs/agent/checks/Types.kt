package net.jonbell.pcs.agent.checks

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import net.jonbell.pcs.agent.extract.Extraction
import net.jonbell.pcs.agent.extract.NormalizedText
import net.jonbell.pcs.agent.extract.Ocr
import net.jonbell.pcs.agent.extract.PageRenderer
import net.jonbell.pcs.agent.extract.Region
import net.jonbell.pcs.core.rules.Ground

/*
 * Deterministic checks (agent.md §3.2). A check reads an Extraction and returns findings; every
 * finding names the check@version that made it, the ground it is evidence for (null for a signal),
 * an anchor, and the quoted evidence, which must be findable at the anchor (concepts prop:S4).
 */

/** INFO is reported but never a flag; LOW is an explicit low-severity signal; MEDIUM and above, or any ground, is a flag. */
@Serializable
enum class Severity { INFO, LOW, MEDIUM, HIGH }

/**
 * Where a finding's evidence is. With a [channel], `[start, end)` indexes that channel's text;
 * otherwise it indexes the text of [page].
 */
@Serializable
data class Anchor(
    val page: Int? = null,
    val channel: String? = null,
    val start: Int? = null,
    val end: Int? = null,
    val region: Region? = null,
)

@Serializable
data class Finding(
    val check: String,
    val version: String,
    /** A [Ground] key, or null for a signal that is not evidence for any ground by itself. */
    val ground: String?,
    val severity: Severity,
    /** The detectors that fired, primary first (e.g. `render-mode-3`, `ocr-diff`). */
    val vectors: List<String>,
    val message: String,
    /** The evidence, verbatim from the text at [anchor]; null when the evidence is a measurement. */
    val quote: String?,
    val anchor: Anchor,
    val measured: Map<String, String> = emptyMap(),
    val detail: String? = null,
) {
    val vector: String get() = vectors.first()

    /** A flag is what the false-flag rate counts: any ground, or MEDIUM and above. */
    val isFlag: Boolean get() = ground != null || severity >= Severity.MEDIUM
}

interface Check {
    val id: String

    fun run(ctx: ScreenContext): List<Finding>
}

/** The rendering and OCR a screen may use. Both are optional: without them the detectors that need pixels are skipped. */
data class ScreenConfig(
    val format: FormatPolicy = FormatPolicy(),
    val authors: AuthorInfo = AuthorInfo(),
    val resolver: ReferenceResolver = ReferenceResolver.None,
    val ocr: Ocr? = null,
    /** Disable the direct vector detectors, leaving only the OCR diff (for measuring the diff alone). */
    val hiddenVectors: Boolean = true,
)

/** One paper under screening, with the analyses the checks share computed once. */
class ScreenContext(val pdf: ByteArray, val x: Extraction, val config: ScreenConfig) {
    val renderer: PageRenderer by lazy { PageRenderer(pdf) }

    val hidden: HiddenAnalysis by lazy { HiddenDetector.analyze(this) }

    fun version(id: String): String = Checks.version(id)

    fun finding(
        check: String,
        ground: Ground?,
        severity: Severity,
        vectors: List<String>,
        message: String,
        quote: String?,
        anchor: Anchor,
        measured: Map<String, String> = emptyMap(),
        detail: String? = null,
    ) = Finding(check, version(check), ground?.key, severity, vectors, message, quote, anchor, measured, detail)

    fun close() = renderer.close()
}

/** prop:S4: a quotation is real only if the text at its anchor is that quotation. */
object Anchors {
    fun verify(x: Extraction, f: Finding): Boolean {
        val a = f.anchor
        val q = f.quote ?: return f.measured.isNotEmpty()
        val s = a.start ?: return false
        val e = a.end ?: return false
        val text =
            if (a.channel != null) {
                x.channel(a.channel)?.text
            } else {
                a.page?.let { p -> x.pages.getOrNull(p - 1)?.text }
            } ?: return false
        if (s < 0 || e > text.length || s >= e) return false
        return text.substring(s, e) == q
    }

    /** Matches in `text` (pattern-scan results over [NormalizedText]) as original-text ranges. */
    fun originalRange(n: NormalizedText, r: IntRange): IntRange = n.originalRange(r.first, r.last + 1)
}

/** The checks, by id, and the content-hash version of each check directory (computed by the build). */
object Checks {
    private val versions: Map<String, String> by lazy {
        val res = Checks::class.java.getResourceAsStream("/net/jonbell/pcs/agent/check-versions.properties")
        val props = java.util.Properties()
        res?.use { props.load(it) }
        props.entries.associate { it.key.toString() to it.value.toString() }
    }

    fun version(id: String): String = versions[id] ?: "unversioned"

    fun ids(): Set<String> = versions.keys

    fun all(): List<Check> = listOf(FormatCheck, RefsDoiCheck, AnonymityCheck, InjectionHiddenCheck, InjectionChannelsCheck, InjectionAddressedCheck)
}

private val reportJson =
    Json {
        prettyPrint = true
        encodeDefaults = true
    }

@Serializable
data class ScreenReport(val sha256: String, val pages: Int, val findings: List<Finding>) {
    fun toJson(): String = reportJson.encodeToString(serializer(), this)
}

object Screening {
    /** The report together with the extraction it came from, so a caller can verify anchors (S4). */
    class Screened(val report: ScreenReport, val extraction: Extraction)

    fun screen(
        pdf: ByteArray,
        config: ScreenConfig = ScreenConfig(),
        parser: net.jonbell.pcs.agent.extract.ReferenceParser = net.jonbell.pcs.agent.extract.HeuristicReferenceParser,
    ): Screened {
        val x = net.jonbell.pcs.agent.extract.PdfExtractor(parser).extract(pdf)
        val ctx = ScreenContext(pdf, x, config)
        try {
            val all = Checks.all().flatMap { it.run(ctx) }
            return Screened(ScreenReport(x.sha256, x.layout.pageCount, all), x)
        } finally {
            ctx.close()
        }
    }

    fun run(
        pdf: ByteArray,
        config: ScreenConfig = ScreenConfig(),
        parser: net.jonbell.pcs.agent.extract.ReferenceParser = net.jonbell.pcs.agent.extract.HeuristicReferenceParser,
    ): ScreenReport = screen(pdf, config, parser).report
}
