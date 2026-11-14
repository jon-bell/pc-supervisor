package pcs.core.earlyreject

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.time.Instant

/*
 * What early reject hands to the chairs (spec §6, §10.4 E). Both artifacts are data: PC Supervisor
 * never sends mail, and the decisions reach HotCRP only through Writeback (M5), which applies a
 * [DecisionArtifact] after a dry run and a chair's confirmation. Nothing in here touches HotCRP.
 */

/**
 * A drafted HotCRP Mail-tool message to the reviewers of every candidate: [search] picks the papers (paste it
 * into the Mail tool's paper search, recipients "Reviewers"), [subject] and [body] are the template. HotCRP
 * fills in `%NUMBER%` and `%TITLE%` per paper. [recipients] lists the reviewers the search reaches, so a chair can
 * check it (E-2: every candidate's reviewers are included).
 */
public data class MailDraft(val search: String, val subject: String, val body: String, val pids: List<Long>, val recipients: Set<String>)

/** One decision of the artifact. */
public data class DecisionRow(val pid: Long, val decision: String)

/**
 * The decision artifact for HotCRP: a bulk-assignment CSV (`paper,action,decision`) that sets the decision of each
 * paper the chair confirmed, a notice template for the Mail tool (to the authors: it names no reviewer and says
 * nothing of any bump, C2), and the search that selects those papers for the notice.
 */
public data class DecisionArtifact(val rows: List<DecisionRow>, val notice: String, val authorSearch: String) {
    /** The same decisions as M5's Writeback artifact: a chair reviews HotCRP's dry run, confirms, and Writeback applies it. */
    public fun toWriteback(): pcs.core.writeback.DecisionArtifact = pcs.core.writeback.DecisionArtifact(rows.associate { it.pid to it.decision }, notice)

    public fun toCsv(): String = "paper,action,decision\n" + rows.joinToString("") { "${it.pid},decision,${it.decision}\n" }

    public fun toJson(): JsonObject =
        buildJsonObject {
            put("kind", "early-reject-decisions")
            put(
                "rows",
                JsonArray(
                    rows.map { r ->
                        buildJsonObject {
                            put("pid", r.pid)
                            put("decision", r.decision)
                        }
                    },
                ),
            )
            put("csv", toCsv())
            put("notice", notice)
            put("authorSearch", authorSearch)
        }
}

public object EarlyRejectArtifacts {
    /** HotCRP paper-number search: `1 4 9`, runs as ranges (`10-12`). */
    public fun searchOf(pids: List<Long>): String {
        val sorted = pids.distinct().sorted()
        val parts = mutableListOf<String>()
        var i = 0
        while (i < sorted.size) {
            var j = i
            while (j + 1 < sorted.size && sorted[j + 1] == sorted[j] + 1) j++
            parts += if (j - i >= 2) "${sorted[i]}-${sorted[j]}" else (i..j).map { sorted[it].toString() }.joinToString(" ")
            i = j + 1
        }
        return parts.joinToString(" ")
    }

    /**
     * The mail to the candidates' reviewers asking for a last word (Q16's bump window). [window] gives the
     * deadline in the text. Candidates already bumped or objected to still get it only if they are waiting: the
     * draft is for the papers the window is open on.
     */
    public fun mailDraft(report: ErReport, window: ErWindow = report.window, zoneName: String = "UTC"): MailDraft {
        val cands = report.candidates.filter { it.status == ErStatus.WAITING }
        val until = window.close?.let { deadline(it, zoneName) }
        val body =
            buildString {
                appendLine("Paper #%NUMBER%, \"%TITLE%\", is a candidate for early rejection: its initial reviews are all negative.")
                appendLine()
                appendLine("Before we decide, please re-read the paper and the reviews, and update your own review and score if you now see it differently.")
                if (until != null) appendLine("If you want to change your score, please do so by $until. If your view hasn't changed, no reply is needed.")
                appendLine()
                appendLine("Thank you.")
            }
        return MailDraft(
            search = searchOf(cands.map { it.pid }),
            subject = "Paper #%NUMBER%: a last look before early rejection",
            body = body,
            pids = cands.map { it.pid },
            recipients = cands.flatMap { c -> c.reviewers.map { it.email } }.toSet(),
        )
    }

    private fun deadline(t: Instant, zoneName: String): String =
        java.time.format.DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm z").withZone(java.time.ZoneId.of(zoneName)).format(t)

    /** The decisions for the papers a chair confirms from [report] (only `READY` ones can be confirmed, E-1). */
    public fun decisions(report: ErReport, confirmed: Set<Long> = report.ready.map { it.pid }.toSet(), decision: String = "Reject"): DecisionArtifact {
        val rows = report.ready.filter { it.pid in confirmed }.map { DecisionRow(it.pid, decision) }
        val notice =
            "Dear author,\n\nAfter the first round of reviews, the program committee has decided not to take paper #%NUMBER%, \"%TITLE%\", " +
                "further, and so it will not enter the author response phase. The reviews are available on the submission site.\n"
        return DecisionArtifact(rows, notice, searchOf(rows.map { it.pid }))
    }
}
