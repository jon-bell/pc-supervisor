package net.jonbell.pcs.core.triage

import net.jonbell.pcs.core.bundle.BundleFinding
import net.jonbell.pcs.core.rules.Conventions
import net.jonbell.pcs.core.rules.Ground

/*
 * Every text this module drafts, rendered from grounds and findings. The notices go to authors, so they name the ground and nothing
 * about how it was found: not the AC, not who gave a second opinion, not which engine, not that a model was involved (C2). `lint`
 * is the template check that property asks for; the tests run it over every template and every ground.
 */
public object Notices {
    /** What a ground means to an author, in the venue's voice. Each reads after "the paper". */
    public fun groundText(g: Ground): String =
        when (g) {
            Ground.FORMAT -> "does not meet the submission format requirements in the call for papers"
            Ground.SCOPE -> "is outside the scope of the conference described in the call for papers"
            Ground.ANONYMITY -> "contains information that identifies its authors, which the double-anonymous policy in the call for papers does not allow"
            Ground.FABRICATED_REFERENCE -> "cites references that do not exist"
            Ground.MISUSED_CITATION -> "cites works in ways that do not support the claims made for them"
            Ground.NO_CONTRIBUTION -> "does not state a contribution that can be evaluated"
            Ground.NOMINATION_NONCOMPLIANCE -> "does not meet the reviewer-nomination requirement in the call for papers"
            Ground.PROMPT_INJECTION -> "contains hidden text addressed to an automated reader, which the call for papers does not allow"
        }

    /** The notice a chair sends from HotCRP's mail tool when a paper is removed. The placeholders are HotCRP's own mail keywords. */
    public fun removal(g: Ground): String =
        "Dear author,\n\nThe program committee has decided not to review paper #%NUMBER%, \"%TITLE%\". The paper ${groundText(g)}. " +
            "Under the call for papers, a paper like this is rejected before review, so it will not be reviewed.\n\nThank you for submitting it.\n"

    /** The notice that opens a fix window (Q1): what to fix, and until when. [due] is already formatted in the venue's zone. */
    public fun remedyOffer(g: Ground, due: String): String =
        "Dear author,\n\nPaper #%NUMBER%, \"%TITLE%\", ${groundText(g)}. You may upload a corrected version until $due. " +
            "If the paper is corrected by then, it will be reviewed as usual; if it is not, it will be rejected before review.\n"

    /** The warning of Q10's "warn, then reject": what is missing, and that nothing else has happened yet. */
    public fun warning(): String =
        "Dear author,\n\nPaper #%NUMBER%, \"%TITLE%\", ${groundText(Ground.NOMINATION_NONCOMPLIANCE)}. " +
            "Please correct this as the call for papers describes. Until you do, the paper is not in good standing.\n"

    /** What a chair sends to ask one PC member for a second opinion (Q2). The member is told no more than they need. */
    public fun secondOpinionRequest(g: Ground): String =
        "Hello,\n\nCould you give a second opinion on paper #%NUMBER%, \"%TITLE%\"? The area chair thinks the paper ${groundText(g)}. " +
            "Please read the paper only as far as you need to decide, and then complete the short screening review in HotCRP: in its Triage field choose " +
            "Keep if the paper should stay in review, or any of the Refer values if you agree it should be desk rejected. " +
            "Your choice is recorded as it stands; " +
            "a review left without one is not an opinion.\n"

    /**
     * The screening record as a comment (spec §11): its first line is the marker, so a sync reads it as a trace. It lists the verified
     * findings and the quoted text that anchors each, never an engine, and states that the AC decides.
     */
    public fun findingsComment(findings: List<BundleFinding>): String {
        val sb = StringBuilder(Conventions.FINDINGS_MARKER).append('\n')
        sb.append("Screening record for this paper. These are checks, not decisions: the area chair decides, in the screening review.\n")
        for (f in findings.filter { it.verified }.sortedWith(compareBy({ it.ground.orEmpty() }, { it.check }, { it.key }))) {
            sb.append("\n- ").append(
                f.ground?.let {
                    "Possible ${Ground.ofKey(it)?.key ?: it}"
                } ?: f.kind,
            ).append(" (").append(f.check).append(", ").append(f.severity).append(")\n")
            for (a in f.anchors) {
                val where = listOfNotNull(a.page?.let { "p. $it" }, a.label.takeIf { it.isNotBlank() }).joinToString(", ")
                sb.append("  ").append(if (where.isNotEmpty()) "$where: " else "").append('"').append(a.quote.replace('\n', ' ').take(240)).append("\"\n")
            }
        }
        return sb.toString()
    }

    private val email = Regex("""[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}""")
    private val forbidden =
        listOf(
            "second opinion",
            "area chair",
            " AC ",
            "engine",
            "language model",
            " LLM",
            "agent",
            "screening bundle",
            "bumped",
            "referred by",
            "agreed",
            "metareview",
        )

    /** C2's template lint: a text for authors must not name a person, an engine, or how the ground was found. Empty when clean. */
    public fun lint(text: String, names: Collection<String> = emptyList()): List<String> =
        buildList {
            email.findAll(text).forEach { add("an email address: ${it.value}") }
            names.filter { it.isNotBlank() && text.contains(it, ignoreCase = true) }.forEach { add("a name: $it") }
            forbidden.filter { text.contains(it, ignoreCase = true) }.forEach { add("the words \"${it.trim()}\"") }
        }
}
