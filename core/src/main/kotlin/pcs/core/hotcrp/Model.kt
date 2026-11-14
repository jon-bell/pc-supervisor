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
    /** The review round's name (`screen` for a triage or second opinion, spec §11); null in the unnamed round. */
    val round: String? = null,
)

public data class Comment(
    val cid: Long,
    val pid: Long,
    val authorEmail: String?,
    val text: String?,
    val topic: String?,
    val visibility: String?,
    /** The response round's name for an author response (`"1"` for the unnamed round); null for a discussion comment. */
    val responseRound: String?,
    val draft: Boolean,
    val modifiedAt: Long?,
    val tags: List<String>,
) {
    val response: Boolean get() = responseRound != null
}

public data class PaperRecord(
    val pid: Long,
    val title: String?,
    val status: String?,
    val decision: String?,
    val authors: List<String>,
    /** PC member email → conflict type, as HotCRP reports it. */
    val pcConflicts: Map<String, String>,
    val modifiedAt: Long?,
    /** Tags as the viewer sees them, `name#value`; a chair sees hidden and chair-only tags. */
    val tags: List<String> = emptyList(),
)
