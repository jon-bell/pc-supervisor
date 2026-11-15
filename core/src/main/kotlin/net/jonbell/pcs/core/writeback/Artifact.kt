package net.jonbell.pcs.core.writeback

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import net.jonbell.pcs.core.imports.Csv

/**
 * What a chair reviews, confirms and applies (concepts §3.2; spec §6). An artifact is plain data:
 * it says what to change in HotCRP and, from that, what the next sync must show ([expectations]).
 */
@Serializable
public sealed interface Artifact {
    /** The kind, as stored and shown. */
    public val kind: String

    /** One line for the list. */
    public fun summary(): String
}

/** One paper's tag changes: [add] entries are `name` or `name#value`; [remove] entries are names. */
@Serializable
public data class TagChange(val pid: Long, val add: List<String> = emptyList(), val remove: List<String> = emptyList())

/** Tags, including the hidden `pcs-*` traces of spec §11, through `/api/assign` (`tag`, `cleartag`). */
@Serializable
@SerialName("tags")
public data class TagArtifact(val changes: List<TagChange>, val label: String = "Tags") : Artifact {
    override val kind: String get() = "tags"

    override fun summary(): String = "$label: ${changes.sumOf {
        it.add.size
    }} to add, ${changes.sumOf { it.remove.size }} to remove on ${changes.map { it.pid }.distinct().size} papers"
}

/** Review assignments (a Plan, a fix-up of an imported TPMS assignment) as HotCRP assignment rows. */
@Serializable
@SerialName("assignments")
public data class AssignmentArtifact(val rows: List<Map<String, String>>, val label: String = "Assignments") : Artifact {
    override val kind: String get() = "assignments"

    override fun summary(): String = "$label: ${rows.size} rows"

    public companion object {
        /** A bulk-assign CSV (`paper,action,email,...`): HotCRP's JSON form takes the same columns. */
        public fun fromCsv(csv: String, label: String = "Assignments"): Result<AssignmentArtifact> =
            Csv.parse(csv).mapCatching { c ->
                require(c.header.isNotEmpty()) { "the CSV has no header" }
                AssignmentArtifact(c.records.map { (_, f) -> c.header.zip(f).filter { it.second.isNotEmpty() }.toMap() }, label)
            }
    }
}

/** A comment on a paper. [visibility] is HotCRP's: `admin`, `pc`, `rev` or `au`. [actas] posts as that user. */
@Serializable
@SerialName("comment")
public data class CommentArtifact(
    val pid: Long,
    val text: String,
    val visibility: String,
    val actas: String? = null,
    /** Edit this comment instead of adding one (for example to re-scope the findings to admin). */
    val cid: Long? = null,
) : Artifact {
    override val kind: String get() = "comment"

    override fun summary(): String = "Comment on #$pid ($visibility): ${text.lineSequence().first().take(60)}"
}

/** Decisions, with the rendered notice a chair pastes into HotCRP's mail tool (spec §6). */
@Serializable
@SerialName("decision")
public data class DecisionArtifact(val decisions: Map<Long, String>, val notice: String? = null) : Artifact {
    override val kind: String get() = "decision"

    override fun summary(): String = "Decision on ${decisions.size} papers: ${decisions.values.distinct().joinToString()}"
}

/** One review to unsubmit and move to the normal round (spec §11: after triage, and Q5 second opinions). */
@Serializable
public data class ReviewMove(val pid: Long, val email: String, val meta: Boolean)

@Serializable
@SerialName("review-move")
public data class ReviewMoveArtifact(val moves: List<ReviewMove>, val label: String = "Move reviews to the normal round") : Artifact {
    override val kind: String get() = "review-move"

    override fun summary(): String = "$label: ${moves.size} reviews"
}

/**
 * PC membership and tier tags (Appointment). HotCRP's API has no call for them (spec §6): they go through
 * `batch/saveusers.php` or the Users page, so this artifact is handed to a chair, not applied by PC Supervisor.
 */
@Serializable
@SerialName("users")
public data class UserArtifact(val users: List<UserChange>) : Artifact {
    override val kind: String get() = "users"

    override fun summary(): String = "PC membership and tier tags for ${users.size} people (handed off)"

    /** The `saveusers` JSON the chair runs, one object per user. */
    public fun saveUsersJson(): List<String> =
        users.map { u ->
            buildJsonObject {
                put("email", u.email)
                u.name?.let { put("name", it) }
                u.roles?.let { put("roles", it) }
                if (u.tags.isNotEmpty()) put("tags", u.tags.joinToString(" "))
            }.toString()
        }
}

@Serializable
public data class UserChange(val email: String, val name: String? = null, val roles: String? = null, val tags: List<String> = emptyList())

internal object ArtifactJson {
    val json = Json { classDiscriminator = "type" }

    fun encode(a: Artifact): String = json.encodeToString(Artifact.serializer(), a)

    fun decode(s: String): Artifact = json.decodeFromString(Artifact.serializer(), s)

    /** The `/api/assign` rows for an artifact that goes through it. */
    fun assignRows(a: Artifact): JsonArray? =
        when (a) {
            is TagArtifact ->
                JsonArray(
                    a.changes.flatMap { c ->
                        c.remove.map {
                            buildJsonObject {
                                put("pid", c.pid)
                                put("action", "cleartag")
                                put("tag", it)
                            }
                        } +
                            c.add.map {
                                buildJsonObject {
                                    put("pid", c.pid)
                                    put("action", "tag")
                                    put("tag", it)
                                }
                            }
                    },
                )
            is AssignmentArtifact ->
                JsonArray(
                    a.rows.map { r ->
                        JsonObject(
                            r.mapValues { (k, v) ->
                                if (k == "pid" ||
                                    k == "paper"
                                ) {
                                    v.toLongOrNull()?.let { n -> JsonPrimitive(n) } ?: JsonPrimitive(v)
                                } else {
                                    JsonPrimitive(v)
                                }
                            },
                        )
                    },
                )
            is DecisionArtifact ->
                JsonArray(
                    a.decisions.map { (pid, d) ->
                        buildJsonObject {
                            put("pid", pid)
                            put("action", "decision")
                            put("decision", d)
                        }
                    },
                )
            is ReviewMoveArtifact ->
                JsonArray(
                    a.moves.flatMap { m ->
                        listOf(
                            buildJsonObject {
                                put("pid", m.pid)
                                put("action", "unsubmitreview")
                                put("user", m.email)
                            },
                            buildJsonObject {
                                put("pid", m.pid)
                                put("action", if (m.meta) "metareview" else "pcreview")
                                put("user", m.email)
                                put("round", "unnamed")
                            },
                        )
                    },
                )
            is CommentArtifact, is UserArtifact -> null
        }

    fun commentBody(a: CommentArtifact): JsonObject =
        buildJsonObject {
            put("text", a.text)
            put("visibility", a.visibility)
        }
}
