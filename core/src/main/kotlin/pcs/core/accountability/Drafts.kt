package pcs.core.accountability

import pcs.core.hotcrp.HotcrpLinks
import pcs.core.rules.Conventions
import pcs.core.rules.ReqDisposition
import pcs.core.rules.Trace
import pcs.core.writeback.TagArtifact
import pcs.core.writeback.TagChange

/** The text of a request for the Mail tool, and the HotCRP search to open it on. */
public data class RequestDraft(
    val pid: Long,
    val ordinal: String,
    val reviewerName: String,
    val subject: String,
    val body: String,
    /** HotCRP's paper search for the message; a chair picks "Reviewers" and unticks everyone but [reviewerName]. */
    val search: String,
    val link: String?,
    val steps: List<String>,
)

/**
 * Request drafts and the Writeback artifacts that record what a chair did (spec §11). PC Supervisor never sends: HotCRP's
 * mail tool has no API (a token gets a 401 from the page) and cannot address one reviewer, so a chair sends the text from
 * the web UI and then records the `pcs-req-…` tag here. Nothing in a draft comes from review text (AR3): it is the criteria's
 * text, the AC's own words, and the paper's number and title through HotCRP's mail merge.
 */
public object AccDrafts {
    /** Renders the message from the criteria's text plus the AC's words (AR1: only criteria on the list; the reviewer sees which). */
    public fun draft(s: ReqSuggestion, chosen: List<Int>, list: List<Criterion>, words: String, dueH: Long, links: HotcrpLinks?): RequestDraft {
        val cited = list.filter { it.id in chosen }
        require(cited.isNotEmpty()) { "a request cites at least one criterion from the PC chairs' list" }
        require(chosen.all { c -> list.any { it.id == c } }) { "a request cites only criteria on the PC chairs' list" }
        val body =
            buildString {
                appendLine("Dear %NAME%,")
                appendLine()
                appendLine(
                    "Thank you for your review of paper #%NUMBER%, \"%TITLE%\" (review ${s.ordinal}). The area chair would like you to look at it again against these parts of the reviewer guidelines:",
                )
                appendLine()
                cited.forEach { appendLine("  ${it.id}. ${it.text}") }
                if (words.isNotBlank()) {
                    appendLine()
                    appendLine(words.trim())
                }
                appendLine()
                appendLine("Please revise the review, or reply to this message within $dueH hours with your reasons. Either answer is welcome.")
            }
        val search = s.pid.toString()
        return RequestDraft(
            s.pid,
            s.ordinal,
            s.name,
            "Your review of paper #%NUMBER% (review ${s.ordinal})",
            body,
            search,
            links?.search(search),
            listOf(
                "Open HotCRP's Mail tool, choose Reviewers, and search for $search.",
                "Untick every recipient except ${s.name} (review ${s.ordinal}); a mail can't be addressed to one reviewer any other way.",
                "Paste the subject and body, send it, then record it here so the sync can see it.",
            ),
        )
    }

    private fun tag(t: Trace) = Conventions.encode(t)

    /** The tag that records a sent request (spec §11, value 0). [n] is the request's number for that review. */
    public fun recordSent(pid: Long, ordinal: String, n: Int = 1): TagArtifact =
        TagArtifact(listOf(TagChange(pid, add = listOf(tag(Trace.RequestSent(pid, ordinal, n, null))))), "Record request $ordinal$n")

    public fun recordReminder(pid: Long, ordinal: String, n: Int = 1): TagArtifact =
        TagArtifact(listOf(TagChange(pid, add = listOf(tag(Trace.Reminder(pid, ordinal, n))))), "Record the reminder for request $ordinal$n")

    /** The disposition goes in the request tag's value (1 revised, 2 explained, 3 declined, 4 no reply, 5 disputed). */
    public fun recordDisposition(pid: Long, ordinal: String, n: Int, d: ReqDisposition): TagArtifact =
        TagArtifact(
            listOf(TagChange(pid, add = listOf(tag(Trace.RequestSent(pid, ordinal, n, d))))),
            "Record disposition ${d.name.lowercase().replace('_', ' ')} for request $ordinal$n",
        )

    /** A PC chair's outcome for a case, on every paper it lists (1 upheld, 2 dismissed). */
    public fun recordCase(papers: List<Long>, number: Int, upheld: Boolean): TagArtifact =
        TagArtifact(
            papers.sorted().map {
                TagChange(it, add = listOf(tag(Trace.Case(it, number, if (upheld) 1 else 2))))
            },
            "Record case $number ${if (upheld) "upheld" else "dismissed"}",
        )
}
