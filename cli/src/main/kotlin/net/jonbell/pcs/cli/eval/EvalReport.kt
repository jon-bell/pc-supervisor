package net.jonbell.pcs.cli.eval

import net.jonbell.pcs.core.readings.Q13
import net.jonbell.pcs.core.readings.Q15

/** The facts about a run that the report states: what it used, never what it read. */
data class RunFacts(
    /** `deterministic only`, or the engine's adapter kind (`replay`, `openai-compat`, `anthropic`, `claude-code`). */
    val engine: String,
    /** What the run opened: empty, `hotcrp`, `engine:<adapter>`; sorted. */
    val network: Set<String>,
    /** `a HotCRP token (read-only)` or `an export directory`. */
    val source: String,
)

/** Everything the report says, as numbers. [render] is the only place they become text, and it applies [Disclosure] to each. */
class EvalReport(
    val facts: RunFacts,
    val reviewed: Int,
    val pcMembers: Int,
    val checks: ChecksResult?,
    val tpms: TpmsResult,
    val composition: CompositionResult,
    val earlyReject: EarlyRejectResult,
    val disclosure: Disclosure = Disclosure(),
) {
    private val d = disclosure

    /**
     * One deterministic Markdown document: no date, no path, no host, no identifier, no title, no name, no text. Rates are percentages with one
     * decimal; every cell passes through [Disclosure]. The same input and the same engine give the same bytes.
     */
    fun render(): String =
        buildString {
            appendLine("# pcs eval: aggregate report")
            appendLine()
            appendLine(
                "Format 1. This file holds counts and rates only. A count under ${d.min} is shown as `<${d.min}`, and a rate whose numerator or complement is under",
            )
            appendLine(
                "${d.min} is shown as `${Disclosure.SUPPRESSED}`. It names no paper, person, title, or text. Read it before you send it; `pcs eval` never sends anything.",
            )
            appendLine()
            appendLine("- Data read from: ${facts.source}")
            appendLine("- Engine: ${facts.engine}")
            appendLine("- Network used: ${if (facts.network.isEmpty()) "none" else facts.network.joinToString(", ")}")
            appendLine()
            appendLine("## Population")
            appendLine()
            appendLine("- Papers that went to review (not withdrawn, not desk rejected): ${d.count(reviewed)}")
            appendLine("- PC members: ${d.count(pcMembers)}")
            appendLine()
            checks(this)
            tpms(this)
            composition(this)
            earlyReject(this)
        }

    private fun checks(sb: StringBuilder) {
        sb.appendLine("## Checks against the recorded desk rejects")
        sb.appendLine()
        val c = checks
        if (c == null) {
            sb.appendLine("Not computed: no directory of PDFs was given (`--pdfs`).")
            sb.appendLine()
            return
        }
        sb.appendLine("- Papers with a PDF: ${d.count(c.papersWithPdf)}")
        sb.appendLine("- Of those, recorded desk rejects: ${d.rate(c.deskRejectedWithPdf, c.papersWithPdf)}")
        sb.appendLine("- Any check: precision ${c.any.precision(d)}, recall ${c.any.recall(d)}")
        sb.appendLine()
        sb.appendLine("A paper is flagged by a check when the check raised a verified flag with a ground or at least medium severity.")
        sb.appendLine()
        sb.appendLine("| Check | Papers flagged | True positives | Precision | Recall |")
        sb.appendLine("|---|---|---|---|---|")
        for (r in c.perCheck.sortedBy { it.check }) {
            val row = Confusion(r.flaggedDesk, r.flagged - r.flaggedDesk, c.deskRejectedWithPdf - r.flaggedDesk)
            // a row inside the any-check row differs from it by the papers only other checks flagged
            val shown = row.shown(d) && (!c.any.shown(d) || d.shows(c.any.tp - row.tp))
            val flagged = if (d.shows(r.flagged) && (!c.any.shown(d) || d.shows(c.any.flagged - r.flagged))) r.flagged.toString() else "<${d.min}"
            if (shown) {
                sb.appendLine("| `${r.check}` | $flagged | ${row.tp} | ${row.precision(d)} | ${row.recall(d)} |")
            } else {
                sb.appendLine("| `${r.check}` | $flagged | ${Disclosure.SUPPRESSED} | ${Disclosure.SUPPRESSED} | ${Disclosure.SUPPRESSED} |")
            }
        }
        sb.appendLine()
        sb.appendLine("Cost per paper screened (USD, over the papers with a PDF): ${d.mean(c.costUsd, c.papersWithPdf)}")
        sb.appendLine()
    }

    private fun tpms(sb: StringBuilder) {
        val t = tpms
        sb.appendLine("## TPMS profile coverage")
        sb.appendLine()
        if (t.pcWithProfile == 0 && t.papersCovered == 0) {
            sb.appendLine("Not computed: no TPMS scores or registrations were given (`--tpms-scores`, `--tpms-registrations`).")
            sb.appendLine()
            return
        }
        sb.appendLine("- PC members with a TPMS profile: ${d.rate(t.pcWithProfile, t.pcMembers)}")
        sb.appendLine(
            "- Papers with at least ${t.needed} PC members, not conflicted and not an author, whose score is at least ${"%.2f".format(
                java.util.Locale.ROOT,
                t.usableMin,
            )}: " +
                d.rate(t.papersCovered, t.papers),
        )
        sb.appendLine("- Rows the kit could not read: ${d.count(t.malformedRows)}")
        sb.appendLine()
    }

    private fun composition(sb: StringBuilder) {
        val c = composition
        sb.appendLine("## Composition feasibility under the venue's conflicts")
        sb.appendLine()
        sb.appendLine(
            "The assignment solver was run on the real conflicts and authorships, one flat affinity, tiers from the tier tags (untagged PC members count as senior),",
        )
        sb.appendLine("and Q14 \"tier decides\"; existing assignments were not read. A paper is composed when its reviewers meet Q13.")
        sb.appendLine()
        sb.appendLine("- PC members with a junior tag: ${d.rate(c.juniors, c.reviewers)}")
        sb.appendLine()
        sb.appendLine("| Q13 reading | Papers composed | Senior seats short | Other seats short |")
        sb.appendLine("|---|---|---|---|")
        for (r in c.rows) {
            val ok = d.showsRate(r.composed, r.planned)
            sb.appendLine(
                "| `${r.q13.key}` | ${d.rate(
                    r.composed,
                    r.planned,
                )} | ${if (ok) d.count(r.seniorShort) else Disclosure.SUPPRESSED} | ${if (ok) d.count(r.thirdShort) else Disclosure.SUPPRESSED} |",
            )
        }
        sb.appendLine()
    }

    private fun earlyReject(sb: StringBuilder) {
        val e = earlyReject
        sb.appendLine("## Early-reject rate under each Q15 reading")
        sb.appendLine()
        sb.appendLine(
            "Of the papers that went to review, the share with at least the required number of complete reviews, all of them negative under the reading.",
        )
        sb.appendLine("Final scores are used, so this is how often the rule would have had a candidate, not what a window would have found.")
        sb.appendLine()
        sb.appendLine("| Q15 reading | Candidates | Of those, rejected at decision |")
        sb.appendLine("|---|---|---|")
        val shown = d.nested(e.rows.map { it.candidates })
        val rejShown = d.nested(e.rows.map { it.candidatesRejected })
        e.rows.forEachIndexed { i, r ->
            val rate = if (shown[i]) d.rate(r.candidates, e.reviewed) else Disclosure.SUPPRESSED
            val rej = if (shown[i] && rejShown[i]) d.rate(r.candidatesRejected, r.candidates) else Disclosure.SUPPRESSED
            sb.appendLine("| `${r.q15.key}` | $rate | $rej |")
        }
        sb.appendLine()
    }

    companion object {
        /** Reading keys the report names, for tests. */
        val READINGS: List<String> = Q13.entries.map { it.key } + Q15.entries.map { it.key }
    }
}
