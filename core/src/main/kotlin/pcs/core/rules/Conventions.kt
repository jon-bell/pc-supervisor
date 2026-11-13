package pcs.core.rules

/*
 * Decoding the spec §11 conventions: the traces non-chair roles leave in HotCRP as hidden
 * (`pcs-*`) and chair-only (`~~pcs-*`) paper tags. A tag that looks like ours but doesn't parse is
 * reported, never guessed at.
 */

public sealed interface Trace {
    public data class Keep(val pid: Long) : Trace

    public data class Refer(val pid: Long, val ground: Ground) : Trace

    /** An accountability request about review [ordinal] (its [n]th), with its disposition if recorded (value 0 = sent). */
    public data class RequestSent(val pid: Long, val ordinal: String, val n: Int, val disposition: ReqDisposition?) : Trace

    public data class Case(val pid: Long, val n: Int, val outcome: Int) : Trace

    public data class Unparsed(val pid: Long, val tag: String) : Trace
}

public object Conventions {
    /** Disposition codes (spec §11): HotCRP tag values are numbers only. */
    public val DISPOSITION_CODES: Map<Int, ReqDisposition> =
        mapOf(
            1 to ReqDisposition.REVISED,
            2 to ReqDisposition.EXPLAINED,
            3 to ReqDisposition.DECLINED,
            4 to ReqDisposition.NO_REPLY,
            5 to ReqDisposition.DISPUTED,
        )

    private val req = Regex("""pcs-req-([A-Z]+)([0-9]+)""")
    private val case = Regex("""~~pcs-case-([0-9]+)""")

    /** Decode one paper's tags (`name#value`). Tags not starting with `pcs-` or `~~pcs-` are someone else's and ignored. */
    public fun decode(pid: Long, tags: List<String>): List<Trace> =
        tags.mapNotNull { t ->
            val name = t.substringBefore('#')
            val value = t.substringAfter('#', "0").toDoubleOrNull()?.toInt()
            if (!name.startsWith("pcs-") && !name.startsWith("~~pcs-")) return@mapNotNull null
            when {
                name == "pcs-keep" -> Trace.Keep(pid)
                name.startsWith("pcs-refer-") -> Ground.ofKey(name.removePrefix("pcs-refer-"))?.let { Trace.Refer(pid, it) } ?: Trace.Unparsed(pid, t)
                req.matches(name) && value != null -> {
                    val m = req.matchEntire(name)!!
                    if (value == 0 || value in DISPOSITION_CODES) {
                        Trace.RequestSent(pid, m.groupValues[1], m.groupValues[2].toInt(), DISPOSITION_CODES[value])
                    } else {
                        Trace.Unparsed(pid, t)
                    }
                }
                case.matches(name) && value != null -> Trace.Case(pid, case.matchEntire(name)!!.groupValues[1].toInt(), value)
                else -> Trace.Unparsed(pid, t)
            }
        }

    /** Encode a trace as the tag the convention prescribes (for Writeback drafts and the round-trip tests). */
    public fun encode(t: Trace): String =
        when (t) {
            is Trace.Keep -> "pcs-keep"
            is Trace.Refer -> "pcs-refer-${t.ground.key}"
            is Trace.RequestSent -> "pcs-req-${t.ordinal}${t.n}#${t.disposition?.let { d -> DISPOSITION_CODES.entries.first { it.value == d }.key } ?: 0}"
            is Trace.Case -> "~~pcs-case-${t.n}#${t.outcome}"
            is Trace.Unparsed -> t.tag
        }
}
