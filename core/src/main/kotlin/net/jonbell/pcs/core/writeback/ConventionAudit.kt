package net.jonbell.pcs.core.writeback

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import net.jonbell.pcs.core.rules.Conventions
import net.jonbell.pcs.core.rules.Trace
import net.jonbell.pcs.core.rules.TriageChoice
import net.jonbell.pcs.core.store.Store
import net.jonbell.pcs.core.store.query

public enum class IssueKind(public val label: String) {
    UNPARSED("a trace that doesn't parse"),
    FORGED_TRIAGE("triage written by someone who isn't the paper's AC"),
    FORGED_FINDINGS("a findings comment by someone who isn't a chair"),
    CONFLICTING("traces that contradict each other"),
    TAGS_NOT_HIDDEN("PC Supervisor's tags aren't hidden on this HotCRP"),
}

/** One thing the sync screen reports about the spec §11 traces. It is reported, never acted on (T6). */
public data class TraceIssue(val kind: IssueKind, val pid: Long?, val detail: String)

/** A triage the convention allows PC Supervisor to act on. */
public data class TriageRead(val pid: Long, val reviewer: String, val rid: Long, val choice: TriageChoice)

/**
 * Reads the shared record (spec §11) from the mirror: which traces parse and who may have written
 * them. HotCRP exposes no author for a tag, so a tag's author can't be checked; that is closed
 * differently, by `tag_hidden = pcs-*` (only administrators set or see hidden tags, verified in
 * `ConventionsTest`) and by reporting an instance where that setting is absent. A review field or
 * comment does name its author, so those are checked here.
 */
public object ConventionAudit {
    private fun tags(json: String): List<String> = Json.parseToJsonElement(json).jsonArray.map { it.jsonPrimitive.content }

    /** Triage that came from a screen-round metareview by the paper's AC: the only kind PC Supervisor acts on. */
    public fun trustedTriage(store: Store): List<TriageRead> = triageReads(store).first

    private data class TriageRow(val rid: Long, val pid: Long, val email: String, val rtype: Int, val status: String, val round: String?, val raw: String?)

    private data class CommentRow(val cid: Long, val pid: Long, val email: String?, val text: String)

    private fun triageReads(store: Store): Pair<List<TriageRead>, List<TraceIssue>> {
        val ok = mutableListOf<TriageRead>()
        val bad = mutableListOf<TraceIssue>()
        store.conn.query(
            "SELECT rid, pid, email, rtype, status, round, json_extract(scores, '$.Tri') FROM review WHERE gone_at IS NULL AND json_extract(scores, '$.Tri') IS NOT NULL ORDER BY rid",
        ) { r ->
            TriageRow(r.getLong(1), r.getLong(2), r.getString(3), r.getInt(4), r.getString(5), r.getString(6), r.getObject(7)?.toString())
        }.forEach { (rid, pid, email, rtype, status, round, raw) ->
            val code = raw?.toDoubleOrNull()?.toInt()
            val choice = code?.let { Conventions.decodeTriage(it) }
            when {
                round != "screen" -> Unit // the field only exists in the screen round
                rtype != 5 ->
                    bad +=
                        TraceIssue(IssueKind.FORGED_TRIAGE, pid, "review $pid/$rid by $email (not the paper's metareviewer) has a Triage value; ignored")
                status != "complete" -> Unit // a draft is not a triage yet
                choice == null ->
                    bad +=
                        TraceIssue(IssueKind.UNPARSED, pid, "the Triage field of $email's metareview on paper $pid holds $raw, which is not keep or a ground")
                else -> ok += TriageRead(pid, email, rid, choice)
            }
        }
        return ok to bad
    }

    public fun run(store: Store): List<TraceIssue> {
        val out = mutableListOf<TraceIssue>()
        // tags: unparsed pcs-* tags, and contradictions between the ones that do parse
        store.conn.query("SELECT pid, tags FROM paper WHERE gone_at IS NULL ORDER BY pid") { it.getLong(1) to tags(it.getString(2)) }.forEach { (pid, tags) ->
            val traces = Conventions.decode(pid, tags)
            traces.filterIsInstance<Trace.Unparsed>().forEach { out += TraceIssue(IssueKind.UNPARSED, pid, "tag ${it.tag} on paper $pid does not parse") }
            val keep = traces.any { it is Trace.Keep }
            val refer = traces.filterIsInstance<Trace.Refer>()
            if (keep &&
                refer.isNotEmpty()
            ) {
                out += TraceIssue(IssueKind.CONFLICTING, pid, "paper $pid has both pcs-keep and pcs-refer-${refer.first().ground.key}")
            }
        }
        // review fields: who wrote a Triage
        out += triageReads(store).second
        // comments: a findings comment must come from a chair
        val chairs =
            store.conn.query("SELECT email, roles FROM person WHERE gone_at IS NULL") { it.getString(1).lowercase() to it.getString(2) }.filter {
                "\"chair\"" in
                    it.second
            }.map { it.first }.toSet()
        store.conn.query(
            "SELECT c.cid, c.pid, c.email, (SELECT text FROM comment_text t WHERE t.cid = c.cid ORDER BY modified_at DESC LIMIT 1) FROM comment c WHERE c.deleted_seen_at IS NULL ORDER BY c.cid",
        ) { CommentRow(it.getLong(1), it.getLong(2), it.getString(3), it.getString(4).orEmpty()) }.forEach { (cid, pid, email, text) ->
            when (val t = Conventions.decodeComment(pid, cid, email, text)) {
                is Trace.Findings ->
                    if (email?.lowercase() !in
                        chairs
                    ) {
                        out +=
                            TraceIssue(
                                IssueKind.FORGED_FINDINGS,
                                pid,
                                "comment $cid on paper $pid by ${email ?: "someone"} claims to be a screening record; ignored",
                            )
                    }
                is Trace.Unparsed ->
                    out +=
                        TraceIssue(IssueKind.UNPARSED, pid, "comment $cid on paper $pid opens with ${t.tag}, which is not a PC Supervisor marker")
                else -> Unit
            }
        }
        // configuration: tags are only a shared record if HotCRP hides pcs-* from everyone but administrators
        val hidden = store.conn.query("SELECT v FROM instance_fact WHERE k = 'tag_hidden'") { it.getString(1) }.firstOrNull()
        if (hidden != null &&
            !hidesPcs(hidden)
        ) {
            out +=
                TraceIssue(
                    IssueKind.TAGS_NOT_HIDDEN,
                    null,
                    "tag_hidden is $hidden: a PC member could write a pcs-* tag, so tags can't be trusted as traces; set it to pcs-*",
                )
        }
        return out
    }

    private fun hidesPcs(setting: String): Boolean {
        val patterns =
            runCatching { Json.parseToJsonElement(setting) }.getOrNull()?.let { e ->
                when (e) {
                    is JsonPrimitive -> e.content.split(' ', ',').filter { it.isNotBlank() }
                    is JsonArray -> e.map { it.jsonPrimitive.content }
                    is JsonObject -> emptyList()
                }
            } ?: setting.split(' ', ',')
        return patterns.any { it == "pcs-*" || it == "pcs-*#" }
    }
}
