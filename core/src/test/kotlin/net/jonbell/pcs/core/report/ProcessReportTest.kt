package net.jonbell.pcs.core.report

import net.jonbell.pcs.core.imports.ImportKind
import net.jonbell.pcs.core.imports.ImportResult
import net.jonbell.pcs.core.imports.Imports
import net.jonbell.pcs.core.secrets.Keychain
import net.jonbell.pcs.core.session.Conferences
import net.jonbell.pcs.core.session.Session
import net.jonbell.pcs.testing.AccFixture
import net.jonbell.pcs.testing.Covers
import net.jonbell.pcs.testing.Family
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Files
import java.nio.file.Path
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * PLAN M20: the process report and the pseudonymous export over a hand-built mirror with canaries in every field that identifies a person or
 * carries text: emails, names, titles, review text, comment text, the appointments sheet.
 */
@Family("T7")
class ProcessReportTest {
    private val repo = Path.of(System.getProperty("pcs.repoRoot"))
    private val canaries = listOf("canary", "zanzibar", "quokka")
    private val keyA = "export-key-A-0123456789"
    private val keyB = "export-key-B-0123456789"

    private class MapKeychain : Keychain {
        val m = mutableMapOf<String, String>()
        override val backend = "in-memory test keychain"

        override fun read(account: String) = m[account]

        override fun write(account: String, secret: String) {
            m[account] = secret
        }
    }

    private val people =
        listOf("ann", "bob", "cy", "dee", "eve").associateWith { "$it.canary@quokka-mail.test" }

    private fun open(dir: Path, extra: String = ""): Session {
        Files.writeString(
            dir.resolve("c.conf"),
            """
            PCS_HOTCRP_URL=http://127.0.0.1:1
            PCS_ANSWERS=${repo.resolve("model/answers/complete.txt")}
            PCS_DB_PATH=${dir.resolve("c.db")}
            PCS_NOW=2030-02-26T12:00
            PCS_TZ=America/New_York
            PCS_PHASE_REVIEW_DUE=2030-02-01T23:59
            PCS_PHASE_DISCUSSION_OPEN=2030-02-12T00:00
            PCS_PHASE_DECISIONS_DUE=2030-03-03T23:59
            PCS_TIER_TAGS=junior=junior,nominee=nominee
            $extra
            """.trimIndent() + "\n",
        )
        val env = mapOf("PCS_CONFERENCES" to dir.toString(), "PCS_DB_KEY" to "t", "PCS_HOTCRP_TOKEN" to "t")
        val c = Conferences.load(dir.resolve("c.conf"), env)
        check(c.settings.isSuccess) { c.problems.toString() }
        return Session.open(c, MapKeychain().also { it.write("pcs/c/db-key", "k") }, env)
    }

    /** [triage] adds 4 refers (format) with a second opinion, 5 kept, 6 refers (scope) and rejected. */
    private fun seed(s: Session, triage: Boolean = false) {
        val f = AccFixture(s.store)
        people.forEach { (n, e) ->
            val tags = if (n == "cy") listOf("junior") else emptyList()
            f.person(e, "Zanzibar ${n.uppercase()} Canaryname", tags)
        }
        for (pid in 1L..3L) {
            f.paper(pid)
            s.store.conn.createStatement().use {
                it.executeUpdate("UPDATE paper SET title='CANARY-TITLE-$pid', authors='[\"${people["ann"]}\"]' WHERE pid=$pid")
            }
        }
        val text = mapOf("revComments" to "CANARY-REVIEW-TEXT quokka")
        f.review(1, people.getValue("bob"), "1A", rtype = 2, words = 400, merit = 4, ratings = listOf("insightful"), texts = text)
        f.review(1, people.getValue("cy"), "1B", rtype = 2, words = 90, merit = 2, ratings = listOf("short", "vague"), texts = text)
        f.review(2, people.getValue("bob"), "2A", rtype = 2, words = 250, merit = 3, texts = text)
        f.review(2, people.getValue("dee"), "2B", status = "draft", rtype = 2, words = 40, merit = null, firstCompleteAt = null, texts = text)
        f.review(1, people.getValue("eve"), null, rtype = 5, words = 10, merit = null, texts = text)
        f.comment(1, people.getValue("eve"), "rev", 1)
        f.comment(1, people.getValue("bob"), "rev", 2)
        s.store.conn.createStatement().use { it.executeUpdate("INSERT INTO comment_text(cid,modified_at,text) VALUES(1,0,'CANARY-COMMENT-TEXT quokka')") }
        if (triage) {
            for (pid in 4L..6L) f.paper(pid)
            val tri = mapOf(4L to 2, 5L to 1, 6L to 3)
            tri.forEach { (pid, code) ->
                val rid = f.review(pid, people.getValue("eve"), null, rtype = 5, words = 10, merit = null, round = "screen")
                s.store.conn.createStatement().use { it.executeUpdate("UPDATE review SET scores='{\"Tri\":$code}' WHERE rid=$rid") }
            }
            f.review(4, people.getValue("bob"), null, rtype = 2, words = 10, merit = null, round = "screen")
            s.store.conn.createStatement().use {
                it.executeUpdate("UPDATE paper SET decision='Reject', title='CANARY-TITLE-6' WHERE pid=6")
                it.executeUpdate("UPDATE paper SET tags='[\"pcs-keep\"]' WHERE pid=5")
            }
        }
        val csv =
            "email,origin,nominated_by,area,ac_email,decision,tier,consent,on_pc_at\n" +
                "${people["cy"]},nominee,1,area,${people["eve"]},accept,junior,yes,\n" +
                "${people["dee"]},nominee,2,area,${people["eve"]},decline,,,\n"
        assertTrue(Imports(s.store, s.clock).import(ImportKind.APPOINTMENTS, csv.toByteArray(), "sheet.csv") is ImportResult.Accepted)
    }

    private fun exportBytes(s: Session, ps: Pseudonyms) = PseudonymousExport.build(s, ps).joinToString("\n") { it.name + "\n" + it.csv() }

    private fun hmac(key: String, msg: String) =
        Mac.getInstance("HmacSHA256").also { it.init(SecretKeySpec(key.toByteArray(), "HmacSHA256")) }.doFinal(msg.toByteArray()).take(16)
            .joinToString("") { "%02x".format(it) }

    @Test
    @Covers("prop:C3")
    fun `the pseudonym is a keyed HMAC of the email, stable for a key and unrelated across keys`() {
        val a = Pseudonyms(keyA.toByteArray())
        val a2 = Pseudonyms(keyA.toByteArray())
        val b = Pseudonyms(keyB.toByteArray())
        val e = "Someone.Canary@Example.org"
        assertEquals("u-" + hmac(keyA, "person:someone.canary@example.org"), a.person(e), "HMAC-SHA256 of the lower-cased email, domain-separated")
        assertEquals(a.person(e), a2.person(" someone.canary@example.org "), "the same key gives the same pseudonym, whatever the case")
        assertNotEquals(a.person(e), b.person(e), "another key gives another pseudonym")
        assertNotEquals(a.person("x@example.org"), a.person("y@example.org"))
        assertNotEquals(a.person("7"), a.paper(7), "people and papers are separate domains")
        assertTrue(Regex("u-[0-9a-f]{32}").matches(a.person(e)))
        val xs = (1..2000).map { a.person("u$it@example.org") }
        assertEquals(xs.size, xs.toSet().size, "no collisions among 2000 people")
        assertThrows(IllegalArgumentException::class.java) { Pseudonyms("short".toByteArray()) }
    }

    @Test
    @Covers("prop:C3")
    fun `the key comes from a setting or a key file, and without one nothing is exported`(
        @TempDir dir: Path,
    ) {
        val file = Files.writeString(dir.resolve("k.txt"), "\n$keyA\nsecond line ignored\n")
        assertEquals(Pseudonyms(keyA.toByteArray()).person("a@x.org"), Pseudonyms.resolve(mapOf("PCS_PSEUDONYM_KEY" to keyA))!!.person("a@x.org"))
        assertEquals(
            Pseudonyms(keyA.toByteArray()).person("a@x.org"),
            Pseudonyms.resolve(mapOf("PCS_PSEUDONYM_KEY_FILE" to file.toString()))!!.person("a@x.org"),
        )
        assertNull(Pseudonyms.resolve(emptyMap()))
        open(dir).use { s ->
            seed(s)
            val out = dir.resolve("out")
            assertNull(ReportFiles.saveExport(s, out), "no key: nothing written")
            assertFalse(Files.exists(out))
        }
    }

    @Test
    @Covers("prop:C3")
    fun `an export is stable for a key and disjoint across keys, and carries pseudonyms for everyone`(
        @TempDir dir: Path,
    ) {
        open(dir).use { s ->
            seed(s)
            val a = Pseudonyms(keyA.toByteArray())
            val first = exportBytes(s, a)
            assertEquals(first, exportBytes(s, Pseudonyms(keyA.toByteArray())), "same key, same bytes")
            val b = exportBytes(s, Pseudonyms(keyB.toByteArray()))
            val ids = Regex("[up]-[0-9a-f]{32}")
            val under = { text: String -> ids.findAll(text).map { it.value }.toSet() }
            assertTrue(under(first).isNotEmpty())
            assertEquals(emptySet<String>(), under(first) intersect under(b), "another key shares no pseudonym")
            people.filterKeys { it != "ann" }.values.forEach { assertTrue(a.person(it) in first, "$it is in the export under their pseudonym") }
            val tables = PseudonymousExport.build(s, a).associateBy { it.name }
            assertEquals(5, tables.getValue("reviews").rows.size)
            assertEquals(2, tables.getValue("comments").rows.size)
            assertEquals(2, tables.getValue("nominations").rows.size)
            assertEquals("nominee", tables.getValue("reviews").rows.first { it[1] == a.person(people.getValue("cy")) }[2])
        }
    }

    @Test
    @Covers("prop:C3")
    fun `T7 no email, name, title or text canary appears in any exported byte or in the report`(
        @TempDir dir: Path,
    ) {
        open(dir, "PCS_PSEUDONYM_KEY=$keyA").use { s ->
            seed(s, triage = true)
            val out = dir.resolve("out")
            val files = ReportFiles.saveExport(s, out)!! + ReportFiles.saveReport(s, out)
            assertEquals(6, files.size)
            assertTrue("Triage outcomes" in String(Files.readAllBytes(files.last())), "the triage tables are in the report that was scanned")
            for (f in files) {
                val bytes = String(Files.readAllBytes(f), Charsets.ISO_8859_1).lowercase()
                for (c in canaries) assertFalse(c in bytes, "$c appears in ${f.fileName}")
                assertFalse("@" in bytes && f.fileName.toString().endsWith(".csv"), "an address in ${f.fileName}")
            }
            // the canaries are in the mirror, so the scan is not vacuous
            val inStore =
                s.store.conn.createStatement().use { st ->
                    st.executeQuery("SELECT count(*) FROM person WHERE lower(email) LIKE '%canary%'").use {
                        it.next()
                        it.getInt(1)
                    }
                }
            assertEquals(5, inStore)
        }
    }

    @Test
    fun `the report renders every module's section, deterministically, as Markdown and HTML`(
        @TempDir dir: Path,
    ) {
        open(dir).use { s ->
            seed(s)
            val r = ProcessReports.build(s)
            assertEquals(
                listOf("overview", "nominations", "screening", "assignment", "progress", "accountability", "early-reject", "discussion"),
                r.sections.map {
                    it.id
                },
            )
            val md = ReportRender.markdown(r)
            assertEquals(md, ReportRender.markdown(ProcessReports.build(s)))
            assertEquals(ReportRender.html(r), ReportRender.html(ProcessReports.build(s)))
            r.sections.forEach { assertTrue("## ${it.title}" in md, it.title) }
            assertTrue(r.section("overview").available)
            assertTrue(r.section("nominations").available)
            assertFalse(r.section("early-reject").available, "no early-reject window date: says why")
            assertTrue("PCS_PHASE_EARLYREJECT_OPEN" in r.section("early-reject").note!!)
            val overview = r.section("overview").tables.first().rows.associate { it[0] to it[1] }
            assertEquals("3", overview["papers"])
            assertEquals("4", overview["reviews (non-AC)"])
            assertEquals("1", overview["metareviews"])
            val nom = r.section("nominations").tables.first { it.title.startsWith("Acceptance") }.rows.associate { it[0] to it[1] }
            assertEquals("50.0%", nom["acceptance rate (accepted of decided)"])
            val depth = r.section("progress").tables.first { it.title.startsWith("Depth") }
            val juniors = depth.rows.first { it[0] == "nominee" }
            assertEquals("90", juniors[2])
            assertEquals("1", juniors[3], "one review under the 150-word floor")
            assertEquals("2", juniors[4], "two negative flags")
            assertTrue("<h2 id=\"progress\">" in ReportRender.html(r))
        }
    }

    @Test
    @Covers("prop:C3")
    fun `the screening section counts triage outcomes, and only counts`(
        @TempDir dir: Path,
    ) {
        open(dir).use { s ->
            seed(s, triage = true)
            val sec = ProcessReports.build(s).section("screening")
            assertTrue(sec.available)
            val outcomes = sec.tables.first { it.title == "Triage outcomes" }.rows.associate { it[0] to it[1] }
            assertEquals("3", outcomes["papers in the triage queue"])
            assertEquals("1", outcomes["kept by the AC"])
            assertEquals("2", outcomes["referred by the AC"])
            assertEquals("1", outcomes["referred, with a second opinion given"])
            assertEquals("1", outcomes["removed (desk rejected)"])
            assertEquals(mapOf("format" to "1", "scope" to "1"), sec.tables.first { it.title == "Referrals by ground" }.rows.associate { it[0] to it[1] })
            assertEquals(mapOf("scope" to "1"), sec.tables.first { it.title == "Removed by ground" }.rows.associate { it[0] to it[1] })
            val timing = sec.tables.first { it.title.startsWith("Timing of removals (Q3 reading:") }.rows.associate { it[0] to it[1] }
            assertEquals(1, timing.filterKeys { it.startsWith("removed at the") }.values.sumOf { it.toInt() })
            assertTrue(sec.tables.all { t -> t.rows.flatten().none { "@" in it || "CANARY" in it } })
        }
    }
}
