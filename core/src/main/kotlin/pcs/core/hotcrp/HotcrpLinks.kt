package pcs.core.hotcrp

import java.net.URI
import java.net.URLEncoder

/** Deep links into HotCRP (spec §4 UI): every row of every table opens its HotCRP page. */
public class HotcrpLinks(private val base: URI) {
    private val root = base.toString().trimEnd('/')

    public fun paper(pid: Long): String = "$root/paper/$pid"

    /** A submitted review has an ordinal (`/review/4A`); an unsubmitted one is addressed by its id. */
    public fun review(
        pid: Long,
        ordinal: String?,
        rid: Long,
    ): String = if (ordinal.isNullOrEmpty()) "$root/review?p=$pid&r=$rid" else "$root/review/$pid$ordinal"

    public fun search(q: String): String = "$root/search?q=" + URLEncoder.encode(q, Charsets.UTF_8).replace("+", "%20")
}
