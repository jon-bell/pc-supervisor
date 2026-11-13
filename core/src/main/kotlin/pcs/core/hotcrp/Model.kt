package pcs.core.hotcrp

import kotlinx.serialization.json.JsonElement

/** What the sync reads from HotCRP (spec §1). Field sets are those verified on the harness. */
public data class PcMember(val email: String, val name: String?, val roles: List<String>, val tags: List<String>)

public data class AssignmentRow(val pid: Long, val action: String, val email: String)

public data class Review(
    val rid: Long,
    val pid: Long,
    val rtype: Int,
    val status: String,
    val ordinal: String?,
    val reviewerEmail: String?,
    val version: String?,
    val modifiedAt: Long?,
    val ratings: List<String>,
    /** Review-form fields by UID (OveMer, RevExp, ...): their set depends on the instance's form. */
    val fields: Map<String, JsonElement>,
)

public data class Comment(
    val cid: Long,
    val pid: Long,
    val authorEmail: String?,
    val text: String?,
    val topic: String?,
    val visibility: String?,
    val response: Boolean,
    val draft: Boolean,
    val modifiedAt: Long?,
    val tags: List<String>,
)
