package pcs.core.accountability

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import pcs.core.config.Settings
import pcs.core.nominations.Candidate
import pcs.core.nominations.Decision
import pcs.core.rules.Tier
import pcs.core.store.Store
import pcs.core.store.TagSeen
import pcs.core.store.query
import java.time.Instant

/** The chairs' settings for this module (`PCS_CRITERION_<n>`, `PCS_REQUEST_DUE_H`, `PCS_FIELD_WEAKNESS`, `PCS_THRESH_MIN_WORDS`, spec §4.1). */
public data class AccConfig(
    val criteria: List<Criterion>,
    val dueH: Long = 48,
    val signal: SignalConfig = SignalConfig(),
) {
    public companion object {
        private val signalSuffix = Regex("""\s*\[([a-z, -]+)]\s*$""")

        /** `PCS_CRITERION_3=Backs each weakness with evidence [negative-no-weakness,thin]`: the bracket lists the signals it answers. */
        public fun parseCriterion(id: Int, v: String): Criterion {
            val m = signalSuffix.find(v)
            val signals = m?.groupValues?.get(1)?.split(',')?.map { it.trim() }?.filter { it.isNotEmpty() }?.toSet().orEmpty()
            return Criterion(id, v.removeRange(m?.range ?: v.length..<v.length).trim(), signals)
        }

        public fun from(s: Settings): AccConfig {
            val criteria =
                s.raw.filterKeys { Regex("PCS_CRITERION_[0-9]+").matches(it) }
                    .map { (k, v) -> parseCriterion(k.removePrefix("PCS_CRITERION_").toInt(), v) }.sortedBy { it.id }
            return AccConfig(
                criteria = criteria,
                dueH = s.raw["PCS_REQUEST_DUE_H"]?.toLongOrNull() ?: 48,
                signal =
                    SignalConfig(
                        minWords = s.raw["PCS_THRESH_MIN_WORDS"]?.toIntOrNull() ?: 150,
                        meritAcceptMin = s.meritAcceptMin,
                        weaknessField = s.raw["PCS_FIELD_WEAKNESS"],
                        requiredFields = s.raw["PCS_FIELDS_REQUIRED"]?.split(',')?.map { it.trim() }?.filter { it.isNotEmpty() }?.toSet().orEmpty(),
                        reviewDue = s.phases["REVIEW_DUE"],
                    ),
            )
        }
    }
}

/** Who is senior, junior or a nominee: the appointments sheet (accepted candidates), then tier tags on the person, else senior. */
public class Tiers(private val byEmail: Map<String, PersonTier>) {
    public fun of(email: String): PersonTier = byEmail[email.lowercase()] ?: PersonTier(Tier.SENIOR, false)

    public companion object {
        public fun build(sheet: List<Candidate>, personTags: Map<String, List<String>>, tierTags: Map<String, String>): Tiers {
            val m = mutableMapOf<String, PersonTier>()
            for ((email, tags) in personTags) {
                val junior = tierTags["junior"]?.let { it in tags } == true
                val nominee = tierTags["nominee"]?.let { it in tags } == true
                if (junior || nominee) m[email.lowercase()] = PersonTier(if (junior) Tier.JUNIOR else Tier.SENIOR, nominee)
            }
            for (c in sheet.filter { it.decision == Decision.ACCEPT }) {
                m[c.email.lowercase()] = PersonTier(c.tier ?: Tier.JUNIOR, c.origin == "nominee")
            }
            return Tiers(m)
        }
    }
}

/** One review as the module reads it. [filled] is which fields hold text, not the text; [versionSeenAt] when each version was first seen. */
public data class AccReview(
    val rid: Long,
    val pid: Long,
    val email: String,
    val rtype: Int,
    val status: String,
    val ordinal: String?,
    val words: Int,
    val ratings: List<String>,
    val merit: Int?,
    val firstCompleteAt: Instant?,
    val round: String?,
    val filled: Set<String>,
    val versionSeenAt: List<Long>,
)

/** A suggestion an AC or the junior PC chair asked PC Supervisor to keep (spec §10.4 D). */
public data class ManualSuggestion(val pid: Long, val ordinal: String, val source: Source, val criteria: List<Int>, val reasons: List<String>)

/** Everything the report reads from the store. */
public data class AccInput(
    val now: Instant,
    val reviews: List<AccReview>,
    val paperTags: Map<Long, List<String>>,
    val seen: List<TagSeen.Seen>,
    val names: Map<String, String>,
    val tiers: Tiers,
    val dismissed: Set<Pair<Long, String>>,
    val manual: List<ManualSuggestion>,
    val caseRows: Map<String, String>,
    /** Papers with a comment visible to their reviewers by one of the paper's ACs (a coaching comment, spec §11). */
    val coachedPapers: Set<Long>,
    val acsByPaper: Map<Long, Set<String>>,
)

public object AccLoader {
    public fun load(store: Store, now: Instant, tiers: Tiers, meritField: String): AccInput {
        val c = store.conn
        // Which fields have text, never the text itself: the one place this module touches `review_text`, by id only (AR3).
        val filled =
            c.query("SELECT r.rid, rt.field_uid FROM review_text rt JOIN review r ON r.rid = rt.rid AND r.vtag = rt.vtag") { it.getLong(1) to it.getString(2) }
                .groupBy({ it.first }, { it.second })
        val versions =
            c.query("SELECT rid, seen_at FROM review_version ORDER BY rid, seen_at") { it.getLong(1) to it.getLong(2) }.groupBy({ it.first }, { it.second })
        val reviews =
            c.query(
                "SELECT rid, pid, lower(email), rtype, status, ordinal, word_count, ratings, scores, first_complete_seen_at, round " +
                    "FROM review WHERE gone_at IS NULL AND email IS NOT NULL",
            ) {
                val rid = it.getLong(1)
                AccReview(
                    rid,
                    it.getLong(2),
                    it.getString(3),
                    it.getInt(4),
                    it.getString(5),
                    it.getString(6),
                    it.getInt(7),
                    Json.parseToJsonElement(it.getString(8)).jsonArray.map { r -> r.jsonPrimitive.content },
                    (Json.parseToJsonElement(it.getString(9)).jsonObject[meritField] as? kotlinx.serialization.json.JsonPrimitive)?.content?.toIntOrNull(),
                    it.getObject(10)?.toString()?.toLongOrNull()?.let(Instant::ofEpochSecond),
                    it.getString(11),
                    filled[rid].orEmpty().toSet(),
                    versions[rid].orEmpty(),
                )
            }
        val tags =
            c.query("SELECT pid, tags FROM paper WHERE gone_at IS NULL") {
                it.getLong(1) to Json.parseToJsonElement(it.getString(2)).jsonArray.map { t -> t.jsonPrimitive.content }
            }.toMap()
        val names = c.query("SELECT lower(email), coalesce(name, email) FROM person") { it.getString(1) to it.getString(2) }.toMap()
        val dismissed = c.query("SELECT pid, ordinal FROM acc_dismissal") { it.getLong(1) to it.getString(2) }.toSet()
        val manual =
            c.query("SELECT pid, ordinal, source, criteria, reasons FROM acc_suggestion") {
                ManualSuggestion(
                    it.getLong(1),
                    it.getString(2),
                    Source.ofKey(it.getString(3)),
                    Json.parseToJsonElement(it.getString(4)).jsonArray.map { x -> x.jsonPrimitive.content.toInt() },
                    Json.parseToJsonElement(it.getString(5)).jsonArray.map { x -> x.jsonPrimitive.content },
                )
            }
        val caseRows = c.query("SELECT nominee, status FROM acc_case") { it.getString(1) to it.getString(2) }.toMap()
        val acs =
            reviews.filter { it.rtype == 5 }.groupBy({ it.pid }, { it.email }).mapValues { it.value.toSet() }
        val coached =
            c.query("SELECT pid, lower(email) FROM comment WHERE deleted_seen_at IS NULL AND draft = 0 AND visibility = 'rev'") {
                it.getLong(1) to
                    it.getString(2)
            }
                .filter { (pid, email) -> email in acs[pid].orEmpty() }.map { it.first }.toSet()
        return AccInput(now, reviews, tags, TagSeen.all(store), names, tiers, dismissed, manual, caseRows, coached, acs)
    }
}

/** Local choices (AR4: a dismissal, a case status) never reach HotCRP. */
public object AccLocal {
    public fun dismiss(store: Store, pid: Long, ordinal: String, by: String?, at: Instant) {
        store.conn.prepareStatement("INSERT OR REPLACE INTO acc_dismissal(pid, ordinal, dismissed_at, dismissed_by) VALUES(?,?,?,?)").use {
            it.setLong(1, pid)
            it.setString(2, ordinal)
            it.setLong(3, at.epochSecond)
            it.setString(4, by)
            it.executeUpdate()
        }
    }

    public fun suggest(store: Store, s: ManualSuggestion, at: Instant) {
        store.conn.prepareStatement("INSERT OR REPLACE INTO acc_suggestion(pid, ordinal, source, criteria, reasons, created_at) VALUES(?,?,?,?,?,?)").use {
            it.setLong(1, s.pid)
            it.setString(2, s.ordinal)
            it.setString(3, s.source.key)
            it.setString(4, s.criteria.joinToString(",", "[", "]") { c -> "\"$c\"" })
            it.setString(5, s.reasons.joinToString(",", "[", "]") { r -> Json.encodeToString(kotlinx.serialization.serializer<String>(), r) })
            it.setLong(6, at.epochSecond)
            it.executeUpdate()
        }
    }

    public fun setCase(store: Store, nominee: String, status: String, at: Instant, note: String? = null) {
        store.conn.prepareStatement(
            "INSERT INTO acc_case(nominee, status, opened_at, decided_at, note) VALUES(?,?,?,?,?) ON CONFLICT(nominee) DO UPDATE SET status=excluded.status, decided_at=excluded.opened_at, note=excluded.note",
        ).use {
            it.setString(1, nominee.lowercase())
            it.setString(2, status)
            it.setLong(3, at.epochSecond)
            it.setObject(4, if (status == "open") null else at.epochSecond)
            it.setString(5, note)
            it.executeUpdate()
        }
    }
}
