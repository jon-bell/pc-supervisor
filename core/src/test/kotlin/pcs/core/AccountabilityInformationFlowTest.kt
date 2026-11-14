package pcs.core

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import pcs.core.accountability.AccConfig
import pcs.core.accountability.AccDrafts
import pcs.core.accountability.AccLoader
import pcs.core.accountability.AccLocal
import pcs.core.accountability.AccountabilityPlan
import pcs.core.accountability.AccountabilityReport
import pcs.core.accountability.Criterion
import pcs.core.accountability.PersonTier
import pcs.core.accountability.ReviewMeta
import pcs.core.accountability.SignalConfig
import pcs.core.accountability.Tiers
import pcs.core.readings.Readings
import pcs.core.rules.Faults
import pcs.core.rules.Tier
import pcs.core.store.Store
import pcs.testing.AccFixture
import pcs.testing.Covers
import pcs.testing.Family
import java.time.Duration
import java.time.Instant
import kotlin.random.Random

/**
 * AR3 and AR4 (PLAN M16, T4): suggestions read review metadata and structure, never text, and a dismissed suggestion leaves
 * no trace. The relational half runs pairs of worlds that differ in one secret and compares what the observer sees. The static
 * half checks the type the signal code is given and the one place the module touches `review_text`.
 */
@Family("T4")
class AccountabilityInformationFlowTest {
    private val due = Instant.parse("2030-03-01T00:00:00Z")
    private val criteria =
        listOf(Criterion(1, "backs each weakness with evidence", setOf("thin", "negative-no-weakness")), Criterion(2, "on time", setOf("late")))
    private val cfg = AccConfig(criteria, 48, SignalConfig(minWords = 150, weaknessField = "Wea", requiredFields = setOf("PapSum"), reviewDue = due))
    private val tiers = Tiers(mapOf("j1@example.org" to PersonTier(Tier.JUNIOR, false), "n1@example.org" to PersonTier(Tier.JUNIOR, true)))

    private class World(val seed: Long) {
        val rnd = Random(seed)
        val papers = (1L..4L).toList()
        val reviewers = listOf("s1@example.org", "j1@example.org", "n1@example.org")

        data class R(val pid: Long, val who: String, val ordinal: String, val words: Int, val merit: Int, val ratings: List<String>, val fields: Set<String>, val late: Boolean)

        val reviews =
            papers.flatMap { p ->
                reviewers.mapIndexed { i, who ->
                    R(
                        p,
                        who,
                        "ABC"[i].toString(),
                        40 + rnd.nextInt(400),
                        1 + rnd.nextInt(4),
                        if (rnd.nextInt(4) ==
                            0
                        ) {
                            listOf("short", "vague")
                        } else {
                            emptyList()
                        },
                        setOf("PapSum", "Wea", "ComAut").filter { rnd.nextInt(3) != 0 }.toSet(),
                        rnd.nextInt(5) == 0,
                    )
                }
            }
        val requests = reviews.filter { rnd.nextInt(5) == 0 }.map { Triple(it.pid, it.ordinal, rnd.nextInt(6)) }
    }

    /** Opening an encrypted store is slow, so each slot keeps one and a world replaces its rows. */
    private val pool = mutableMapOf<Int, Store>()

    private fun store(w: World, text: (World.R, String) -> String, dismissed: Boolean, slot: Int = 0): Store {
        val s =
            pool.getOrPut(slot) {
                Store.open(
                    java.nio.file.Files.createTempFile("pcs-flow", ".db").also {
                        java.nio.file.Files.delete(it)
                        it.toFile().deleteOnExit()
                    },
                    "test-only-key",
                )
            }
        for (t in listOf("person", "paper", "review", "review_version", "review_text", "comment", "tag_seen", "acc_dismissal")) {
            s.conn.createStatement().use {
                it.executeUpdate("DELETE FROM $t")
            }
        }
        val fx = AccFixture(s)
        for (who in w.reviewers) fx.person(who, who)
        fx.person("ac@example.org")
        for (p in w.papers) {
            fx.paper(p, w.requests.filter { it.first == p }.map { "pcs-req-${it.second}1#${it.third}" })
            fx.review(p, "ac@example.org", rtype = 5)
        }
        for (r in w.reviews) {
            val late = if (r.late) due.epochSecond + 86400 else due.epochSecond - 86400
            // the word count and which fields are filled are the structure; what the text says is the secret
            fx.review(
                r.pid,
                r.who,
                ordinal = r.ordinal,
                words = r.words,
                merit = r.merit,
                ratings = r.ratings,
                firstCompleteAt = late,
                texts =
                    r.fields.associateWith { f ->
                        text(r, f)
                    },
            )
        }
        for ((p, o, _) in w.requests) fx.tagSeen(p, "pcs-req-${o}1", "0", 5)
        if (dismissed) for (r in w.reviews) AccLocal.dismiss(s, r.pid, r.ordinal, "chair", due)
        return s
    }

    private fun report(s: Store, f: Faults = Faults.NONE): AccountabilityReport =
        AccountabilityPlan.compute(AccLoader.load(s, due.plus(Duration.ofDays(3)), tiers, "OveMer"), cfg, Readings(), emptyList(), f)

    @Test
    @Covers("prop:AR3")
    fun `pairs of worlds that differ only in review text give identical suggestions`() {
        var nonEmpty = 0
        repeat(200) { i ->
            val w = World(i.toLong())
            val a = report(store(w, { r, f -> "alpha ${r.pid}${r.who}$f" }, dismissed = false))
            val b = report(store(w, { r, f -> "CANARY-$i-a completely different text for $f with other words" }, dismissed = false, slot = 1))
            assertEquals(a.suggestions, b.suggestions, "seed $i")
            assertEquals(a.coaching, b.coaching, "seed $i")
            assertEquals(a.progress, b.progress, "seed $i")
            if (a.suggestions.isNotEmpty()) nonEmpty++
            // a canary in the text reaches nothing the module produces, drafts included
            val out =
                b.toString() +
                    b.suggestions.mapNotNull { s ->
                        if (s.criteria.isEmpty()) null else AccDrafts.draft(s, s.criteria, criteria, "my words", 48, null).toString()
                    }.joinToString()
            assertFalse(out.contains("CANARY"), "seed $i")
        }
        assertTrue(nonEmpty > 150, "the worlds should mostly have suggestions: $nonEmpty")
    }

    @Test
    @Covers("prop:AR4")
    fun `pairs of worlds that differ only in whether suggestions were dismissed give identical engagement records`() {
        var withRecords = 0
        repeat(200) { i ->
            val w = World(1000L + i)
            val open = report(store(w, { _, _ -> "text" }, dismissed = false))
            val dismissed = report(store(w, { _, _ -> "text" }, dismissed = true, slot = 1))
            assertEquals(open.engagement, dismissed.engagement, "seed $i")
            assertEquals(open.requests, dismissed.requests, "seed $i")
            assertEquals(open.cases, dismissed.cases, "seed $i")
            if (open.engagement.isNotEmpty()) withRecords++
            // negative control: the specification mutant "a dismissed suggestion counts" makes the two worlds differ
            if (w.requests.isEmpty()) {
                assertTrue(
                    report(store(w, { _, _ -> "text" }, dismissed = true, slot = 1), Faults(dismissedSuggestionCounts = true)).engagement.isNotEmpty() ||
                        dismissed.suggestions.none { it.status.name == "DISMISSED" },
                )
            }
        }
        assertTrue(withRecords > 100, "$withRecords")
    }

    @Test
    @Covers("prop:AR3")
    fun `the signal code is given metadata and structure only`() {
        val fields = ReviewMeta::class.java.declaredFields.filter { !java.lang.reflect.Modifier.isStatic(it.modifiers) }
        val allowed = setOf("long", "int", "boolean", "java.lang.Long", "java.lang.Integer", "java.time.Instant")
        for (f in fields) {
            val type = f.genericType.typeName
            val ok =
                type in allowed ||
                    (f.name in setOf("reviewer", "group", "ordinal") && type == "java.lang.String") ||
                    (f.name == "filledFields" && type == "java.util.Set<java.lang.String>") ||
                    (f.name == "ratings" && type == "java.util.List<java.lang.String>") ||
                    (f.name == "peerMerits" && type == "java.util.List<java.lang.Integer>")
            assertTrue(ok, "ReviewMeta.${f.name}: $type could hold review text")
        }
        assertTrue(fields.size >= 10)
        assertTrue(fields.none { Regex("text|body|content|comment|summary", RegexOption.IGNORE_CASE).containsMatchIn(it.name) })
    }

    @Test
    @Covers("prop:AR3", "prop:C1")
    fun `the module touches review text in exactly one query, which selects field ids and never the text`() {
        val dir = Repo.path("core/src/main/kotlin/pcs/core/accountability")
        val hits =
            java.nio.file.Files.list(dir).use { fs -> fs.toList() }.flatMap { f ->
                java.nio.file.Files.readAllLines(f).filter {
                    Regex("review_text|comment_text|\\bfts\\b|review_version.*scores").containsMatchIn(it) &&
                        !it.trimStart().startsWith("*") &&
                        !it.trimStart().startsWith("//")
                }.map { f.fileName.toString() to it.trim() }
            }
        assertEquals(1, hits.size, hits.toString())
        assertTrue(hits.single().second.contains("SELECT r.rid, rt.field_uid FROM review_text rt JOIN review r"), hits.single().second)
        assertFalse(Regex("SELECT[^\"]*\\brt\\.text\\b").containsMatchIn(hits.single().second))
        // and nothing in the module's sources imports an engine or an HTTP client
        val imports =
            java.nio.file.Files.list(dir).use { fs -> fs.toList() }.flatMap { java.nio.file.Files.readAllLines(it).filter { l -> l.startsWith("import ") } }
        assertTrue(imports.none { it.contains("agent") || it.contains("ktor") || it.contains("java.net") || it.contains("HotcrpClient") }, imports.toString())
    }
}
