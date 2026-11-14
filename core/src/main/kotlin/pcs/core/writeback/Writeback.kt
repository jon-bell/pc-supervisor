package pcs.core.writeback

import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import pcs.core.hotcrp.HotcrpWriter
import pcs.core.rules.Faults
import pcs.core.store.Store
import pcs.core.store.exec
import pcs.core.store.query
import pcs.core.time.Clock
import java.net.URI

/** A Writeback step that isn't allowed: the message says why. */
public class WritebackException(message: String) : IllegalStateException(message)

/** What HotCRP said a dry run would do (spec §6). [supported] is false where HotCRP has no dry run, and [lines] is then a local preview. */
@Serializable
public data class DryRun(
    val valid: Boolean,
    val supported: Boolean,
    val lines: List<String>,
    val changes: List<Map<String, String>> = emptyList(),
    val messages: List<String> = emptyList(),
)

public enum class WritebackStatus(public val key: String) {
    DRAFTED("drafted"),
    DRY_RUN("dry-run"),
    CONFIRMED("confirmed"),
    APPLIED("applied"),
    HANDED_OFF("handed-off"),
    OBSERVED("observed"),
    MISMATCH("mismatch"),
    FAILED("failed"),
    ;

    public companion object {
        public fun of(k: String): WritebackStatus = entries.first { it.key == k }
    }
}

/** One row of the ledger: an artifact and where it is. */
public data class ArtifactRecord(
    val id: Long,
    val artifact: Artifact,
    val status: WritebackStatus,
    val draftedAt: Long,
    val dryRun: DryRun?,
    val confirmedBy: String?,
    val appliedAt: Long?,
    val observedAt: Long?,
    val mismatch: String?,
    val applyMessage: String?,
) {
    public val summary: String get() = artifact.summary()
}

/**
 * Writeback (concepts §3.2, spec §6): draft, dry run in HotCRP, confirm, apply, observe on the
 * next sync. PC Supervisor changes HotCRP only here (H1): [apply] needs a confirmed artifact whose
 * dry run is current, meaning its payload is unchanged and HotCRP, asked again just before the
 * write, still answers the same diff. Every applied artifact is later checked against the mirror
 * ([Ledger.observe], run by the sync): its effect shows, or it is flagged with the mismatch (H2).
 */
public class Writeback(
    private val store: Store,
    private val clock: Clock,
    private val base: URI,
    private val token: String,
    private val faults: Faults = Faults.NONE,
) {
    private val json = Json

    private fun <T> withWriter(f: suspend (HotcrpWriter) -> T): T =
        kotlinx.coroutines.runBlocking { HotcrpWriter(base, token).use { f(it) } }

    public fun draft(a: Artifact): Long {
        val now = clock.now().epochSecond
        store.conn.exec(
            "INSERT INTO writeback_artifact(kind,payload,summary,status,drafted_at) VALUES(?,?,?,?,?)",
            a.kind,
            ArtifactJson.encode(a),
            a.summary(),
            WritebackStatus.DRAFTED.key,
            now,
        )
        return store.conn.query("SELECT last_insert_rowid()") { it.getLong(1) }.single()
    }

    /** Replace an artifact that hasn't been applied. Any dry run and confirmation are void. */
    public fun revise(id: Long, a: Artifact) {
        val r = get(id)
        if (r.status in setOf(WritebackStatus.APPLIED, WritebackStatus.HANDED_OFF, WritebackStatus.OBSERVED, WritebackStatus.MISMATCH)) {
            throw WritebackException("artifact $id is already applied; draft a new one")
        }
        store.conn.exec(
            "UPDATE writeback_artifact SET kind=?, payload=?, summary=?, status=?, dry_run_at=NULL, dry_run_digest=NULL, dry_run_result=NULL, confirmed_at=NULL, confirmed_by=NULL WHERE id=?",
            a.kind,
            ArtifactJson.encode(a),
            a.summary(),
            WritebackStatus.DRAFTED.key,
            id,
        )
    }

    public fun get(id: Long): ArtifactRecord = list().firstOrNull { it.id == id } ?: throw WritebackException("no artifact $id")

    public fun list(): List<ArtifactRecord> = Ledger.list(store)

    /** Asks HotCRP what the artifact would do, without doing it. */
    public fun dryRun(id: Long): DryRun {
        val r = get(id)
        if (r.status in setOf(WritebackStatus.APPLIED, WritebackStatus.HANDED_OFF, WritebackStatus.OBSERVED, WritebackStatus.MISMATCH)) {
            throw WritebackException("artifact $id is already applied")
        }
        val dr = compute(r.artifact)
        val digest = sha256(ArtifactJson.encode(r.artifact) + json.encodeToString(DryRun.serializer(), dr))
        store.conn.exec(
            "UPDATE writeback_artifact SET status=?, dry_run_at=?, dry_run_digest=?, dry_run_result=?, confirmed_at=NULL, confirmed_by=NULL WHERE id=?",
            if (dr.valid) WritebackStatus.DRY_RUN.key else WritebackStatus.DRAFTED.key,
            clock.now().epochSecond,
            digest,
            json.encodeToString(DryRun.serializer(), dr),
            id,
        )
        return dr
    }

    /** A chair's confirmation of the dry run they saw. Only a chair may confirm (concepts §3.9). */
    public fun confirm(id: Long): ArtifactRecord {
        val r = get(id)
        val dr = r.dryRun ?: throw WritebackException("artifact $id has no dry run; run one first")
        if (r.status != WritebackStatus.DRY_RUN || !dr.valid) throw WritebackException("artifact $id's dry run is not valid; fix the draft and dry-run again")
        val stored = store.conn.query("SELECT dry_run_digest FROM writeback_artifact WHERE id = $id") { it.getString(1) }.single()
        if (stored !=
            sha256(ArtifactJson.encode(r.artifact) + json.encodeToString(DryRun.serializer(), dr))
        ) {
            throw WritebackException("artifact $id changed since its dry run")
        }
        val who = withWriter { it.whoami() }
        if ("chair" !in who.roles) throw WritebackException("only a PC chair may confirm a Writeback; ${who.email} is not one")
        store.conn.exec(
            "UPDATE writeback_artifact SET status=?, confirmed_at=?, confirmed_by=? WHERE id=?",
            WritebackStatus.CONFIRMED.key,
            clock.now().epochSecond,
            who.email,
            id,
        )
        return get(id)
    }

    /** Applies a confirmed artifact: the only write path to HotCRP (H1). */
    public fun apply(id: Long): ArtifactRecord {
        val r = get(id)
        if (!faults.applyWithoutDryRun) {
            if (r.status != WritebackStatus.CONFIRMED) throw WritebackException("artifact $id is ${r.status.key}, not confirmed")
            val seen = r.dryRun!!
            // the dry run must be current: ask HotCRP again; if its answer moved, the chair confirms again
            val fresh = compute(r.artifact)
            if (fresh.changes != seen.changes || fresh.valid != seen.valid) {
                store.conn.exec("UPDATE writeback_artifact SET status=?, confirmed_at=NULL, confirmed_by=NULL WHERE id=?", WritebackStatus.DRY_RUN.key, id)
                throw WritebackException("HotCRP's dry run for artifact $id changed since it was confirmed; review it again")
            }
        }
        val a = r.artifact
        val now = clock.now().epochSecond
        try {
            val (expect, message, handed) = execute(a, r.dryRun)
            store.conn.exec(
                "UPDATE writeback_artifact SET status=?, applied_at=?, apply_result=?, expectations=? WHERE id=?",
                if (handed) WritebackStatus.HANDED_OFF.key else WritebackStatus.APPLIED.key,
                now,
                message,
                json.encodeToString(ListSerializer(Expect.serializer()), expect),
                id,
            )
        } catch (e: WritebackException) {
            store.conn.exec("UPDATE writeback_artifact SET status=?, apply_result=? WHERE id=?", WritebackStatus.FAILED.key, e.message, id)
            throw e
        }
        return get(id)
    }

    private fun compute(a: Artifact): DryRun =
        when (a) {
            is CommentArtifact ->
                withWriter { w ->
                    val c = w.comment(a.pid, ArtifactJson.commentBody(a), a.cid, a.actas, dryRun = true)
                    DryRun(
                        c.ok,
                        true,
                        c.changeList.map {
                            "comment on #${a.pid}: $it"
                        }.ifEmpty { listOf("comment on #${a.pid}: no change") },
                        emptyList(),
                        c.messages,
                    )
                }
            is UserArtifact -> userPreview(a)
            else ->
                withWriter { w ->
                    val res = w.assign(ArtifactJson.assignRows(a)!!, dryRun = true)
                    DryRun(
                        res.ok && res.valid,
                        true,
                        res.changes.map(::line).ifEmpty {
                            if (res.valid) listOf("nothing would change") else emptyList()
                        },
                        res.changes,
                        res.messages,
                    )
                }
        }

    private fun line(row: Map<String, String>): String {
        val head = "#${row["pid"]} ${row["action"]}"
        return head + row.filterKeys { it != "pid" && it != "action" }.entries.joinToString("") { " ${it.key}=${it.value}" }
    }

    /** HotCRP has no dry run for users: the preview compares the request with the mirror (spec §6). */
    private fun userPreview(a: UserArtifact): DryRun {
        val have = store.conn.query("SELECT email, roles FROM person WHERE gone_at IS NULL") { it.getString(1).lowercase() to it.getString(2) }.toMap()
        val lines =
            a.users.map { u ->
                val state = if (u.email.lowercase() in have) "on the PC (roles ${have[u.email.lowercase()]})" else "not on the PC"
                "${u.email}: $state; set roles=${u.roles ?: "(unchanged)"} tags=${u.tags.joinToString(" ").ifEmpty { "(unchanged)" }}"
            }
        val problems = a.users.filter { !it.email.contains('@') }.map { "not an email address: ${it.email}" }
        return DryRun(problems.isEmpty(), false, lines, emptyList(), problems + "HotCRP has no dry run for users; this is a preview against the last sync")
    }

    private data class Executed(val expect: List<Expect>, val message: String, val handedOff: Boolean)

    private fun execute(a: Artifact, seen: DryRun?): Executed =
        when (a) {
            is CommentArtifact ->
                withWriter { w ->
                    val c = w.comment(a.pid, ArtifactJson.commentBody(a), a.cid, a.actas, dryRun = false)
                    if (!c.ok) throw WritebackException("HotCRP refused the comment: ${c.messages.joinToString("; ")}")
                    val cid = c.cid ?: a.cid ?: throw WritebackException("HotCRP saved the comment but returned no id")
                    Executed(listOf(CommentIs(cid, a.visibility, sha256(a.text))), "comment $cid saved", false)
                }
            is UserArtifact ->
                Executed(
                    a.users.flatMap { u ->
                        listOfNotNull(u.roles?.split(',', ' ')?.firstOrNull { it.isNotBlank() }?.let { PcRoleIs(u.email, it) }) +
                            u.tags.map { UserTagListed(it.substringBefore('#')) }
                    },
                    "handed to a chair: run batch/saveusers.php with the JSON shown",
                    true,
                )
            else ->
                withWriter { w ->
                    val res = w.assign(ArtifactJson.assignRows(a)!!, dryRun = false)
                    if (!res.ok || !res.valid) throw WritebackException("HotCRP refused the assignment: ${res.messages.joinToString("; ")}")
                    Executed(expectationsOf(a, res.changes), "${res.count} changes made", false)
                }
        }

    private fun expectationsOf(a: Artifact, changes: List<Map<String, String>>): List<Expect> {
        val out = mutableListOf<Expect>()
        for (c in changes) {
            val pid = c["pid"]?.toLongOrNull() ?: continue
            val action = c["action"].orEmpty()
            val email = c["email"] ?: c["user"]
            when (action) {
                "tag", "settag", "addtag" -> c["tag"]?.let { t -> out += TagHas(pid, t.substringBefore('#'), t.substringAfter('#', "").ifEmpty { null }) }
                "cleartag", "notag", "deletetag" -> c["tag"]?.let { out += TagLacks(pid, it.substringBefore('#')) }
                "decision" -> c["decision"]?.let { out += DecisionIs(pid, it) }
                "primary", "primaryreview", "pri" -> email?.let { out += ReviewIs(pid, it, 4) }
                "secondary", "secondaryreview", "sec" -> email?.let { out += ReviewIs(pid, it, 3) }
                "pcreview", "optionalreview" -> email?.let { out += ReviewIs(pid, it, 2) }
                "metareview", "meta" -> email?.let { out += ReviewIs(pid, it, 5) }
                "clearreview", "noreview", "unassignreview", "clearprimary", "clearsecondary", "clearpcreview", "clearmetareview", "clearmeta" ->
                    email?.let {
                        out +=
                            ReviewGone(pid, it)
                    }
            }
        }
        if (a is ReviewMoveArtifact) {
            // the move is judged by where the review ends up, not by the intermediate rows
            val touched = changes.mapNotNull { c -> c["pid"]?.toLongOrNull()?.let { it to (c["email"] ?: c["user"]).orEmpty().lowercase() } }.toSet()
            out.removeAll { it is ReviewIs }
            a.moves.filter { (it.pid to it.email.lowercase()) in touched }.forEach { out += ReviewMoved(it.pid, it.email) }
        }
        return out
    }

    /** The `saveusers` commands for a handed-off [UserArtifact], as the chair would run them on the HotCRP server. */
    public fun handOffCommands(id: Long): List<String> {
        val a = get(id).artifact as? UserArtifact ?: throw WritebackException("artifact $id is not a user artifact")
        return a.saveUsersJson().map { "php batch/saveusers.php -e '$it'" }
    }
}
