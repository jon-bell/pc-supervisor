package net.jonbell.pcs.core.writeback

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import net.jonbell.pcs.core.rules.Conventions
import net.jonbell.pcs.core.rules.Trace
import net.jonbell.pcs.core.rules.TriageChoice
import net.jonbell.pcs.core.store.Store
import net.jonbell.pcs.core.store.query

/**
 * The §11 review moves, drafted from the mirror (spec §11, rows 1 and 3). Nothing here writes:
 * the drafts go through [Writeback] like any other artifact. Only a triage that
 * [ConventionAudit.trustedTriage] accepts is acted on; a forged one is reported, not used.
 */
public object ScreenRound {
    private fun pcsTags(store: Store, pid: Long): List<Trace> =
        store.conn.query("SELECT tags FROM paper WHERE pid = $pid") { r -> Json.parseToJsonElement(r.getString(1)).jsonArray.map { it.jsonPrimitive.content } }
            .firstOrNull()?.let { Conventions.decode(pid, it) }.orEmpty()

    /** The hidden tag for each paper whose AC's triage is in and not yet mirrored, then the unsubmit-and-move of those metareviews. */
    public fun triageDrafts(store: Store): List<Artifact> {
        val todo =
            ConventionAudit.trustedTriage(store).filter { t ->
                pcsTags(store, t.pid).none { it is Trace.Keep || it is Trace.Refer }
            }
        if (todo.isEmpty()) return emptyList()
        val tags =
            todo.map {
                TagChange(
                    it.pid,
                    add =
                        listOf(
                            Conventions.encode(
                                if (it.choice is TriageChoice.Keep) Trace.Keep(it.pid) else Trace.Refer(it.pid, (it.choice as TriageChoice.Refer).ground),
                            ),
                        ),
                )
            }
        return listOf(
            TagArtifact(tags, "Mirror the AC's triage into hidden tags"),
            ReviewMoveArtifact(todo.map { ReviewMove(it.pid, it.reviewer, meta = true) }, "Move triage metareviews to the normal round"),
        )
    }

    /** Q5 ("reviews it if it stays"): for each kept paper, second opinions still in the screen round move to the normal round, text kept. */
    public fun secondOpinionDrafts(store: Store): List<Artifact> {
        val moves =
            store.conn.query("SELECT pid, email FROM review WHERE gone_at IS NULL AND round = 'screen' AND rtype <> 5 AND rtype <> 1 ORDER BY pid, email") {
                it.getLong(1) to
                    it.getString(2)
            }
                .filter { (pid, _) -> pcsTags(store, pid).any { it is Trace.Keep } }
                .map { (pid, email) -> ReviewMove(pid, email, meta = false) }
        return if (moves.isEmpty()) emptyList() else listOf(ReviewMoveArtifact(moves, "Move second opinions to the normal round (Q5)"))
    }
}
