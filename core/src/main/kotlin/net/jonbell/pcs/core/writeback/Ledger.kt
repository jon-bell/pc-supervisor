package net.jonbell.pcs.core.writeback

import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import net.jonbell.pcs.core.store.Store
import net.jonbell.pcs.core.store.exec
import net.jonbell.pcs.core.store.query

/** An applied artifact whose effect HotCRP doesn't show (`prop:M2`, Writeback mismatches). */
public data class WritebackMismatch(val id: Long, val summary: String, val problems: String)

/**
 * The record of what was applied and whether the mirror shows it (H2). [observe] runs after every
 * sync: an applied artifact must show its effect on the next one; an artifact already observed is
 * checked again, so an effect later reverted in HotCRP is flagged too. An expectation that a later
 * applied artifact has since changed (the same tag, review or comment) is not held against the
 * earlier one.
 */
public object Ledger {
    private val expectSer = ListSerializer(Expect.serializer())

    public fun list(store: Store): List<ArtifactRecord> =
        store.conn.query(
            "SELECT id, payload, status, drafted_at, dry_run_result, confirmed_by, applied_at, observed_at, mismatch, apply_result FROM writeback_artifact ORDER BY id",
        ) { r ->
            ArtifactRecord(
                id = r.getLong(1),
                artifact = ArtifactJson.decode(r.getString(2)),
                status = WritebackStatus.of(r.getString(3)),
                draftedAt = r.getLong(4),
                dryRun = r.getString(5)?.let { Json.decodeFromString(DryRun.serializer(), it) },
                confirmedBy = r.getString(6),
                appliedAt = r.getObject(7)?.toString()?.toLong(),
                observedAt = r.getObject(8)?.toString()?.toLong(),
                mismatch = r.getString(9),
                applyMessage = r.getString(10),
            )
        }

    public fun mismatches(store: Store): List<WritebackMismatch> =
        list(store).filter { it.status == WritebackStatus.MISMATCH }.map { WritebackMismatch(it.id, it.summary, it.mismatch.orEmpty()) }

    /** Checks every applied artifact against the mirror at [now] (epoch seconds). Returns how many are in mismatch afterwards. */
    public fun observe(store: Store, now: Long): Int {
        val rows =
            store.conn.query(
                "SELECT id, expectations, status, applied_at FROM writeback_artifact WHERE status IN ('applied','handed-off','observed','mismatch') ORDER BY id",
            ) { Row(it.getLong(1), it.getString(2), it.getString(3), it.getLong(4)) }
        // the latest applied artifact that speaks of each fact is the one that answers for it
        val last = mutableMapOf<String, Long>()
        val parsed = rows.associate { it.id to (it.expectations?.let { s -> Json.decodeFromString(expectSer, s) } ?: emptyList()) }
        for (r in rows) parsed.getValue(r.id).forEach { last[it.key] = r.id }
        var bad = 0
        for (r in rows) {
            val problems = parsed.getValue(r.id).filter { last[it.key] == r.id }.mapNotNull { Checks.check(store, it) }
            val status =
                when {
                    problems.isNotEmpty() -> WritebackStatus.MISMATCH
                    else -> WritebackStatus.OBSERVED
                }
            if (status == WritebackStatus.MISMATCH) bad++
            val wasObserved = r.status == "observed"
            store.conn.exec(
                "UPDATE writeback_artifact SET status=?, checked_at=?, mismatch=?, observed_at=? WHERE id=?",
                status.key,
                now,
                problems.takeIf { it.isNotEmpty() }?.joinToString("; "),
                // the first sync that shows the effect; a later regression keeps the time it was first seen
                if (status == WritebackStatus.OBSERVED &&
                    !wasObserved
                ) {
                    now
                } else {
                    store.conn.query("SELECT observed_at FROM writeback_artifact WHERE id=${r.id}") { it.getObject(1)?.toString()?.toLong() }.first()
                },
                r.id,
            )
        }
        return bad
    }

    private data class Row(val id: Long, val expectations: String?, val status: String, val appliedAt: Long)
}
