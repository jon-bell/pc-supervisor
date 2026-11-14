package pcs.core.writeback

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import pcs.core.store.Store
import pcs.core.store.query
import java.security.MessageDigest

/**
 * What the next sync must show once an artifact is applied (spec §6, H2). Expectations come from
 * HotCRP's own dry-run diff, so they name exactly the changes HotCRP said it would make.
 */
@Serializable
public sealed interface Expect {
    /** Two expectations with the same key are about the same fact; a later applied artifact supersedes an earlier one. */
    public val key: String
}

@Serializable
@SerialName("tag")
public data class TagHas(val pid: Long, val name: String, val value: String? = null) : Expect {
    override val key: String get() = "tag:$pid:${name.lowercase()}"
}

@Serializable
@SerialName("notag")
public data class TagLacks(val pid: Long, val name: String) : Expect {
    override val key: String get() = "tag:$pid:${name.lowercase()}"
}

@Serializable
@SerialName("review")
public data class ReviewIs(val pid: Long, val email: String, val rtype: Int) : Expect {
    override val key: String get() = "rev:$pid:${email.lowercase()}"
}

@Serializable
@SerialName("noreview")
public data class ReviewGone(val pid: Long, val email: String) : Expect {
    override val key: String get() = "rev:$pid:${email.lowercase()}"
}

/** The review is back in the unnamed round and not submitted, so its author writes the full review (spec §11). */
@Serializable
@SerialName("moved")
public data class ReviewMoved(val pid: Long, val email: String) : Expect {
    override val key: String get() = "rev:$pid:${email.lowercase()}"
}

@Serializable
@SerialName("comment")
public data class CommentIs(val cid: Long, val visibility: String, val textSha: String) : Expect {
    override val key: String get() = "comment:$cid"
}

@Serializable
@SerialName("decision")
public data class DecisionIs(val pid: Long, val name: String) : Expect {
    override val key: String get() = "decision:$pid"
}

@Serializable
@SerialName("role")
public data class PcRoleIs(val email: String, val role: String) : Expect {
    override val key: String get() = "role:${email.lowercase()}:$role"
}

/** A tier tag set on a user. HotCRP lists tags in use on `/pc` but not who has them (spec §1), so this is all the sync can see. */
@Serializable
@SerialName("usertag")
public data class UserTagListed(val tag: String) : Expect {
    override val key: String get() = "usertag:${tag.lowercase()}"
}

internal fun sha256(s: String): String = MessageDigest.getInstance("SHA-256").digest(s.toByteArray()).joinToString("") { "%02x".format(it) }

/** Evaluates expectations against the mirror. Returns null when it holds, else the mismatch in words. */
internal object Checks {
    fun check(store: Store, e: Expect): String? =
        when (e) {
            is TagHas -> {
                val tags = tagsOf(store, e.pid)
                val have = tags?.firstOrNull { it.substringBefore('#').equals(e.name, true) }
                when {
                    tags == null -> "paper ${e.pid} is not in the mirror"
                    have == null -> "tag ${e.name} is not on paper ${e.pid}"
                    e.value != null &&
                        !sameNumber(
                            have.substringAfter('#', "0"),
                            e.value,
                        ) -> "tag ${e.name} on paper ${e.pid} has value ${have.substringAfter('#', "0")}, expected ${e.value}"
                    else -> null
                }
            }
            is TagLacks ->
                tagsOf(store, e.pid)?.firstOrNull {
                    it.substringBefore('#').equals(e.name, true)
                }?.let { "tag ${e.name} is still on paper ${e.pid}" }
            is ReviewIs -> {
                val r = review(store, e.pid, e.email)
                when {
                    r == null -> "no ${e.email} review on paper ${e.pid}"
                    r.rtype != e.rtype -> "${e.email} on paper ${e.pid} has review type ${r.rtype}, expected ${e.rtype}"
                    else -> null
                }
            }
            is ReviewGone -> review(store, e.pid, e.email)?.let { "${e.email} is still assigned to paper ${e.pid}" }
            is ReviewMoved -> {
                val r = review(store, e.pid, e.email)
                when {
                    r == null -> "no ${e.email} review on paper ${e.pid}"
                    r.round != null -> "the ${e.email} review on paper ${e.pid} is still in round ${r.round}"
                    r.status == "complete" -> "the ${e.email} review on paper ${e.pid} is still submitted"
                    else -> null
                }
            }
            is CommentIs -> {
                val row =
                    store.conn.query(
                        "SELECT c.visibility, c.deleted_seen_at, (SELECT text FROM comment_text t WHERE t.cid = c.cid ORDER BY modified_at DESC LIMIT 1) FROM comment c WHERE c.cid = ${e.cid}",
                    ) {
                        Triple(it.getString(1), it.getObject(2), it.getString(3))
                    }.firstOrNull()
                when {
                    row == null -> "comment ${e.cid} is not in the mirror"
                    row.second != null -> "comment ${e.cid} was deleted"
                    row.first != e.visibility -> "comment ${e.cid} has visibility ${row.first}, expected ${e.visibility}"
                    sha256(row.third.orEmpty()) != e.textSha -> "comment ${e.cid} text was edited"
                    else -> null
                }
            }
            is DecisionIs -> {
                val d = store.conn.query("SELECT decision FROM paper WHERE pid = ${e.pid} AND gone_at IS NULL") { it.getString(1) }.firstOrNull()
                if (d.equals(e.name, true)) null else "paper ${e.pid} has decision ${d ?: "none"}, expected ${e.name}"
            }
            is PcRoleIs -> {
                val roles =
                    store.conn.prepareStatement("SELECT roles FROM person WHERE email = ? AND gone_at IS NULL").use { st ->
                        st.setString(1, e.email)
                        st.executeQuery().use { if (it.next()) it.getString(1) else null }
                    }
                when {
                    roles == null -> "${e.email} is not on the PC"
                    // `/pc` lists PC members, and names only the roles beyond plain PC (chair, sysadmin, ...)
                    e.role != "pc" && "\"${e.role}\"" !in roles -> "${e.email} lacks the ${e.role} role"
                    else -> null
                }
            }
            is UserTagListed -> {
                val tags = store.conn.query("SELECT v FROM instance_fact WHERE k = 'pc_tags'") { it.getString(1) }.firstOrNull().orEmpty()
                if (tags.split(' ').any { it.equals(e.tag, true) }) null else "tag ${e.tag} is not among the PC tags HotCRP lists"
            }
        }

    private fun sameNumber(a: String, b: String) = a.toDoubleOrNull() == b.toDoubleOrNull() && a.toDoubleOrNull() != null || a == b

    private fun tagsOf(store: Store, pid: Long): List<String>? =
        store.conn.query("SELECT tags FROM paper WHERE pid = $pid AND gone_at IS NULL") { it.getString(1) }.firstOrNull()?.let {
            kotlinx.serialization.json.Json.parseToJsonElement(it).let { a ->
                (a as kotlinx.serialization.json.JsonArray).map { x -> (x as kotlinx.serialization.json.JsonPrimitive).content }
            }
        }

    private data class R(val rtype: Int, val status: String, val round: String?)

    private fun review(store: Store, pid: Long, email: String): R? =
        store.conn.prepareStatement("SELECT rtype, status, round FROM review WHERE pid = ? AND lower(email) = lower(?) AND gone_at IS NULL").use { st ->
            st.setLong(1, pid)
            st.setString(2, email)
            st.executeQuery().use { if (it.next()) R(it.getInt(1), it.getString(2), it.getString(3)) else null }
        }
}
