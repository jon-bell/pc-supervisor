package net.jonbell.pcs.core.rules

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

    /** The reminder for request [n] about review [ordinal] was sent (a chair records it; its time is when a sync first saw the tag). */
    public data class Reminder(val pid: Long, val ordinal: String, val n: Int) : Trace

    /**
     * A chair-only case trace on a paper the case lists: [n] is the nominee's HotCRP contact id, and [outcome] 0 is
     * recorded, 1 upheld and 2 dismissed (spec §11).
     */
    public data class Case(val pid: Long, val n: Int, val outcome: Int) : Trace

    /** The fix window offered on an anonymity violation closes at [dueEpoch] (seconds, a whole hour: the tag holds hours); a chair's mail-tool notice goes with it. */
    public data class RemedyDue(val pid: Long, val dueEpoch: Long) : Trace

    /** The authors were warned about a nomination non-compliance (Q10). */
    public data class Warned(val pid: Long) : Trace

    /** The paper's AC objects to an early reject (concepts EarlyReject.ac_objects); the chair records it as this tag. */
    public data class EarlyObjection(val pid: Long) : Trace

    /** The AC's triage in a screen-round metareview (the `Triage` review field, spec §11). */
    public data class Triage(val pid: Long, val reviewer: String, val choice: TriageChoice) : Trace

    /** A screening-findings comment posted through Writeback (spec §11): [cid], authored by [author]. */
    public data class Findings(val pid: Long, val cid: Long, val author: String?) : Trace

    public data class Unparsed(val pid: Long, val tag: String) : Trace
}

/** What the triage field says: keep the paper, or refer it on a ground. */
public sealed interface TriageChoice {
    public data object Keep : TriageChoice

    public data class Refer(val ground: Ground) : TriageChoice
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

    /** First line of a screening-findings comment (spec §11). */
    public const val FINDINGS_MARKER: String = "[pcs:findings]"

    /**
     * The `Triage` field's radio values (spec §11): 1 is keep, and 2, 3, ... are the grounds in the
     * model's order (2 format, 3 scope, 4 anonymity, ...). The instance's field must use these symbols.
     */
    public fun decodeTriage(code: Int): TriageChoice? =
        when {
            code == 1 -> TriageChoice.Keep
            code >= 2 && code - 2 < Ground.entries.size -> TriageChoice.Refer(Ground.entries[code - 2])
            else -> null
        }

    public fun encodeTriage(c: TriageChoice): Int =
        when (c) {
            TriageChoice.Keep -> 1
            is TriageChoice.Refer -> 2 + c.ground.ordinal
        }

    /** A comment is a trace only if it opens with a `[pcs:` marker: the findings marker parses, any other `[pcs:` opening doesn't. */
    public fun decodeComment(pid: Long, cid: Long, author: String?, text: String): Trace? {
        val first = text.lineSequence().firstOrNull()?.trim().orEmpty()
        return when {
            first == FINDINGS_MARKER -> Trace.Findings(pid, cid, author)
            first.startsWith("[pcs:") -> Trace.Unparsed(pid, first)
            else -> null
        }
    }

    /**
     * HotCRP keeps a tag value as a float of about six significant digits (verified: 1893456000 comes back as
     * 1893460000), so an epoch in seconds does not survive. `pcs-remedy-due` carries the epoch in **hours**,
     * rounded up, which is exact (six digits until the year 2084).
     */
    @Suppress("FunctionName")
    private fun REMEDY_HOURS(epochSeconds: Long): Long = Math.floorDiv(epochSeconds + 3599, 3600L)

    private val req = Regex("""pcs-req-([A-Z]+)([0-9]+)""")
    private val remind = Regex("""pcs-remind-([A-Z]+)([0-9]+)""")
    private val case = Regex("""~~pcs-case-([0-9]+)""")

    /** Decode one paper's tags (`name#value`). Tags not starting with `pcs-` or `~~pcs-` are someone else's and ignored. */
    public fun decode(pid: Long, tags: List<String>): List<Trace> =
        tags.mapNotNull { t ->
            val name = t.substringBefore('#')
            val value = t.substringAfter('#', "0").toDoubleOrNull()?.toInt()
            val epoch = t.substringAfter('#', "0").toDoubleOrNull()?.toLong()
            if (!name.startsWith("pcs-") && !name.startsWith("~~pcs-")) return@mapNotNull null
            when {
                name == "pcs-keep" -> Trace.Keep(pid)
                name == "pcs-remedy-due" && epoch != null -> Trace.RemedyDue(pid, epoch * 3600)
                name == "pcs-warned" -> Trace.Warned(pid)
                name == "pcs-er-object" -> Trace.EarlyObjection(pid)
                name.startsWith("pcs-refer-") -> Ground.ofKey(name.removePrefix("pcs-refer-"))?.let { Trace.Refer(pid, it) } ?: Trace.Unparsed(pid, t)
                req.matches(name) && value != null -> {
                    val m = req.matchEntire(name)!!
                    if (value == 0 || value in DISPOSITION_CODES) {
                        Trace.RequestSent(pid, m.groupValues[1], m.groupValues[2].toInt(), DISPOSITION_CODES[value])
                    } else {
                        Trace.Unparsed(pid, t)
                    }
                }
                remind.matches(name) -> remind.matchEntire(name)!!.let { Trace.Reminder(pid, it.groupValues[1], it.groupValues[2].toInt()) }
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
            is Trace.Reminder -> "pcs-remind-${t.ordinal}${t.n}"
            is Trace.Case -> "~~pcs-case-${t.n}#${t.outcome}"
            is Trace.RemedyDue -> "pcs-remedy-due#${REMEDY_HOURS(t.dueEpoch)}"
            is Trace.Warned -> "pcs-warned"
            is Trace.EarlyObjection -> "pcs-er-object"
            is Trace.Unparsed -> t.tag
            is Trace.Triage, is Trace.Findings -> throw IllegalArgumentException("a review field or comment, not a tag: $t")
        }
}
