package pcs.core.writeback

import pcs.core.hotcrp.HotcrpLinks

/**
 * The first Writeback actions (PLAN M5): a copyable HotCRP search for any filtered set, nudge
 * comment drafts, and `#chair-attention` tagging. All of them are drafts; a chair applies them.
 */
public object FirstActions {
    /** HotCRP's search for exactly these papers: a bare list of paper numbers. */
    public fun searchQuery(pids: List<Long>): String = pids.sorted().joinToString(" ")

    /** The copyable link into HotCRP for the same set. */
    public fun searchLink(links: HotcrpLinks, pids: List<Long>): String = links.search(searchQuery(pids))

    /** Tag a filtered set for the chairs' attention. */
    public fun chairAttention(pids: List<Long>, tag: String): TagArtifact =
        TagArtifact(pids.sorted().map { TagChange(it, add = listOf(tag)) }, "Tag #$tag")

    /**
     * A reminder about reviews still outstanding on one paper. A comment can't address one reviewer
     * (spec §11), so the wording names reviews by ordinal and is visible to the paper's reviewers.
     * The tone follows spec §7: it says what is outstanding, never who is "disengaged".
     */
    public fun nudge(pid: Long, outstandingOrdinals: List<String>, visibility: String = "rev"): CommentArtifact {
        val which = outstandingOrdinals.sorted().joinToString(", ") { "review $it" }
        val text = "Reminder from the PC chairs: $which for this paper ${if (outstandingOrdinals.size == 1) "is" else "are"} not submitted yet. Please submit when you can, or let us know if you need more time."
        return CommentArtifact(pid, text, visibility)
    }
}
