package pcs.agent.checks

import kotlinx.serialization.Serializable
import pcs.core.rules.Ground

/** What an index says a work is. */
@Serializable
data class ResolvedWork(val doi: String?, val title: String, val year: Int?)

/** Resolves bibliography entries against an index. Real implementations live behind the egress allowlist (agent.md §5.3); tests use [Mock]. */
interface ReferenceResolver {
    sealed interface Result {
        data class Found(val work: ResolvedWork) : Result

        data object NotFound : Result

        /** The index could not be reached or answered with an error: no verdict. */
        data class Unavailable(val why: String) : Result
    }

    fun byDoi(doi: String): Result

    fun byTitle(title: String, year: Int?): Result

    /** No index configured: nothing resolves, and the check says so rather than guessing. */
    data object None : ReferenceResolver {
        override fun byDoi(doi: String) = Result.Unavailable("no resolver configured")

        override fun byTitle(title: String, year: Int?) = Result.Unavailable("no resolver configured")
    }

    /** An in-memory index; makes no network calls. */
    class Mock(private val works: List<ResolvedWork>) : ReferenceResolver {
        override fun byDoi(doi: String) = works.firstOrNull { it.doi.equals(doi, ignoreCase = true) }?.let { Result.Found(it) } ?: Result.NotFound

        override fun byTitle(title: String, year: Int?) =
            works.firstOrNull { RefsDoiCheck.titleSimilarity(it.title, title) >= 0.8 }?.let { Result.Found(it) } ?: Result.NotFound
    }
}

/**
 * `refs.doi` (agent.md §3.2): parse the bibliography, resolve each entry, flag non-resolving and
 * mismatched ones with the entry quoted. Depends on Q6 for whether a fabricated reference is grounds,
 * so the ground is named and the decision gates it later. A missing DOI is reported (INFO), not flagged.
 */
object RefsDoiCheck : Check {
    override val id = "refs.doi"

    fun titleSimilarity(a: String, b: String): Double {
        fun tok(s: String) = s.lowercase().split(Regex("[^a-z0-9]+")).filter { it.length > 2 }.toSet()
        val x = tok(a)
        val y = tok(b)
        if (x.isEmpty() || y.isEmpty()) return 0.0
        return x.intersect(y).size.toDouble() / x.union(y).size
    }

    override fun run(ctx: ScreenContext): List<Finding> =
        ctx.x.references.mapNotNull { r ->
            val anchor = Anchor(r.page, null, r.start, r.end, ctx.x.page(r.page).regionOf(r.start, r.end))
            val quote = ctx.x.page(r.page).text.substring(r.start, r.end)
            val measured = mapOf("label" to r.label)

            fun flag(vec: String, msg: String, sev: Severity = Severity.HIGH, g: Ground? = Ground.FABRICATED_REFERENCE) =
                ctx.finding(id, g, sev, listOf(vec), msg, quote, anchor, measured + (r.doi?.let { mapOf("doi" to it) } ?: emptyMap()))

            if (r.doi != null) {
                when (val res = ctx.config.resolver.byDoi(r.doi)) {
                    is ReferenceResolver.Result.NotFound -> flag("doi-not-found", "Reference [${r.label}]: DOI ${r.doi} does not resolve")
                    is ReferenceResolver.Result.Unavailable ->
                        ctx.finding(
                            id,
                            null,
                            Severity.INFO,
                            listOf("unverified"),
                            "Reference [${r.label}] not verified: ${res.why}",
                            quote,
                            anchor,
                            measured,
                        )
                    is ReferenceResolver.Result.Found -> {
                        val sim = r.title?.let { titleSimilarity(it, res.work.title) } ?: 0.0
                        val yearOff = if (r.year != null && res.work.year != null) kotlin.math.abs(r.year - res.work.year) else 0
                        if (sim < 0.5 || yearOff > 1) {
                            val got = "\"${res.work.title}\", ${res.work.year}"
                            val similarity = "%.2f".format(sim)
                            flag(
                                "doi-mismatch",
                                "Reference [${r.label}]: DOI ${r.doi} resolves to a different work ($got); title similarity $similarity",
                                Severity.MEDIUM,
                            )
                        } else {
                            null
                        }
                    }
                }
            } else if (r.title != null) {
                when (val res = ctx.config.resolver.byTitle(r.title, r.year)) {
                    is ReferenceResolver.Result.NotFound ->
                        flag(
                            "title-not-found",
                            "Reference [${r.label}] has no DOI and its title is in no index",
                            Severity.MEDIUM,
                        )
                    is ReferenceResolver.Result.Unavailable ->
                        ctx.finding(
                            id,
                            null,
                            Severity.INFO,
                            listOf("missing-doi"),
                            "Reference [${r.label}] has no DOI (not verified: ${res.why})",
                            quote,
                            anchor,
                            measured,
                        )
                    is ReferenceResolver.Result.Found ->
                        ctx.finding(
                            id,
                            null,
                            Severity.INFO,
                            listOf("missing-doi"),
                            "Reference [${r.label}] has no DOI; its title resolves to ${res.work.doi ?: "an entry without one"}",
                            quote,
                            anchor,
                            measured,
                        )
                }
            } else {
                null
            }
        }
}
