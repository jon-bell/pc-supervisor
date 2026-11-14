package pcs.core.imports

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import pcs.core.store.Store
import java.nio.file.Files
import java.nio.file.Path
import java.time.Instant

/**
 * `pcs export tpms <dir>` (spec §10.3). TPMS has no API, so the chair sends files to its operator.
 * Written, from the mirror and the latest `appointments` import:
 *
 * - `pc.csv`: the PC list (`email,name`);
 * - `conflicts.csv`: HotCRP's conflicts (`paper,email`), for PC members only;
 * - `load-<tier>-max<N>.csv`: one file per tier, with the tier's members and its load band (`PCS_LOAD_<TIER>_MAX`);
 * - `reviews-per-paper.txt`: the reviews-per-paper target (`PCS_REVIEWS_REQUIRED`).
 *
 * A PC member with no appointments row is senior (spec §4.1 `PCS_TIER_TAGS`). The PDF ZIP comes from HotCRP.
 */
public class TpmsExport(private val store: Store, private val imports: Imports) {
    public data class Result(val dir: Path, val files: List<String>, val pcMembers: Int, val conflicts: Int)

    public fun write(dir: Path, loadMax: Map<String, Int>, reviewsPerPaper: Int, asOf: Instant): Result {
        Files.createDirectories(dir)
        val people = mutableListOf<Pair<String, String>>()
        store.conn.createStatement().use { s ->
            s.executeQuery("SELECT email, COALESCE(name,'') FROM person WHERE gone_at IS NULL ORDER BY email").use { rs ->
                while (rs.next()) people += rs.getString(1).lowercase() to rs.getString(2)
            }
        }
        val pc = people.map { it.first }.toSet()
        val tiers = imports.asOf(ImportKind.APPOINTMENTS, asOf)?.rows.orEmpty().associate { it.key to it.data["tier"].orEmpty() }

        fun tierOf(email: String) = tiers[email]?.takeIf { it.isNotEmpty() } ?: "senior"

        val files = mutableListOf<String>()

        fun put(name: String, text: String) {
            Files.writeString(dir.resolve(name), text)
            files += name
        }
        put("pc.csv", "email,name\n" + people.joinToString("") { "${q(it.first)},${q(it.second)}\n" })
        val conflicts = mutableListOf<Pair<Long, String>>()
        store.conn.createStatement().use { s ->
            s.executeQuery("SELECT pid, pc_conflicts FROM paper WHERE gone_at IS NULL ORDER BY pid").use { rs ->
                while (rs.next()) {
                    val pid = rs.getLong(1)
                    Json.parseToJsonElement(rs.getString(2)).jsonObject.keys.map { it.lowercase() }.filter { it in pc }.sorted().forEach {
                        conflicts +=
                            pid to it
                    }
                }
            }
        }
        put("conflicts.csv", "paper,email\n" + conflicts.joinToString("") { "${it.first},${q(it.second)}\n" })
        for ((tier, members) in people.map { it.first }.groupBy(::tierOf).toSortedMap()) {
            val band = loadMax[tier]
            val name = "load-$tier-max${band ?: "unset"}.csv"
            put(name, "email,tier,max_load\n" + members.joinToString("") { "${q(it)},$tier,${band ?: ""}\n" })
        }
        put("reviews-per-paper.txt", "$reviewsPerPaper\n")
        return Result(dir, files, people.size, conflicts.size)
    }

    private fun q(s: String): String = if (s.any { it == ',' || it == '"' || it == '\n' }) "\"" + s.replace("\"", "\"\"") + "\"" else s
}
