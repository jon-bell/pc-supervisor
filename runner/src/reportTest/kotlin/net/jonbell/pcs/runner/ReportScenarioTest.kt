package net.jonbell.pcs.runner

import kotlinx.coroutines.runBlocking
import net.jonbell.pcs.core.imports.ImportKind
import net.jonbell.pcs.core.imports.ImportResult
import net.jonbell.pcs.core.imports.Imports
import net.jonbell.pcs.core.report.ProcessReports
import net.jonbell.pcs.core.report.PseudonymousExport
import net.jonbell.pcs.core.report.Pseudonyms
import net.jonbell.pcs.core.report.ReportFiles
import net.jonbell.pcs.core.report.ReportRender
import net.jonbell.pcs.core.secrets.Keychain
import net.jonbell.pcs.core.session.Conferences
import net.jonbell.pcs.core.session.Session
import net.jonbell.pcs.core.store.Store
import net.jonbell.pcs.testing.Covers
import net.jonbell.pcs.testing.Family
import net.jonbell.pcs.testing.LocalHarness
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.nio.file.Files
import java.nio.file.Path
import java.security.SecureRandom

/**
 * PLAN M20 on a seeded scenario (`shadow`, or `scale` by hand): sync the harness, import an appointments sheet, render the process report
 * and export the pseudonymous rows. Then T7: the mirror's every email, name and title is scanned for in every exported byte, after canaries
 * are planted in the local mirror (a name, a title and a comment text on every person, paper and comment), and the report is scanned too.
 */
@Family("T7")
@Covers("prop:C3")
class ReportScenarioTest {
    private val repo: Path = Path.of(System.getProperty("pcs.repoRoot"))
    private val name = System.getenv("PCS_REPORT_NAME") ?: "shadow"
    private val out: Path = Path.of(System.getProperty("pcs.reportDir")).resolve(name).also { Files.createDirectories(it) }
    private val token = System.getenv("PCS_HOTCRP_TOKEN") ?: error("PCS_HOTCRP_TOKEN not set")
    private val url = LocalHarness.require(System.getenv("PCS_HOTCRP_URL") ?: error("PCS_HOTCRP_URL not set"))
    private val minPapers = System.getenv("PCS_REPORT_MIN_PAPERS")?.toInt() ?: 140
    private val nonce = ByteArray(5).also { SecureRandom().nextBytes(it) }.joinToString("") { "%02x".format(it) }

    private fun open(): Session {
        val dir = out.resolve("conferences").also { Files.createDirectories(it) }
        Files.deleteIfExists(out.resolve("$name.db"))
        Files.writeString(
            dir.resolve("$name.conf"),
            listOf(
                "PCS_HOTCRP_URL=$url",
                "PCS_ANSWERS=${repo.resolve("model/answers/complete.txt")}",
                "PCS_DB_PATH=${out.resolve("$name.db")}",
                "PCS_TZ=America/New_York",
                "PCS_NOW=2030-02-26T12:00",
                "PCS_PHASE_REVIEW_DUE=2030-02-01T23:59",
                "PCS_PHASE_RESPONSE_OPEN=2030-02-08T00:00",
                "PCS_PHASE_RESPONSE_CLOSE=2030-02-11T23:59",
                "PCS_PHASE_DISCUSSION_OPEN=2030-02-12T00:00",
                "PCS_PHASE_DISCUSSION_CLOSE=2030-03-01T23:59",
                "PCS_PHASE_DECISIONS_DUE=2030-03-03T23:59",
                "PCS_PHASE_EARLYREJECT_OPEN=2030-02-02T00:00",
                "PCS_TIER_TAGS=junior=junior,nominee=nominee",
                "PCS_PSEUDONYM_KEY=report-test-key-$nonce",
            ).joinToString("\n") + "\n",
        )
        val e = mapOf("PCS_HOTCRP_TOKEN" to token, "PCS_DB_KEY" to "report-only-not-secret", "PCS_CONFERENCES" to dir.toString())
        val kc =
            object : Keychain {
                override val backend = "in-memory"

                override fun read(account: String): String? = null

                override fun write(account: String, secret: String) {}
            }
        val c = Conferences.load(dir.resolve("$name.conf"), e)
        check(c.settings.isSuccess) { c.problems.toString() }
        return Session.open(c, kc, e)
    }

    private fun scalar(store: Store, sql: String): Long =
        store.conn.createStatement().use { s ->
            s.executeQuery(sql).use {
                it.next()
                it.getLong(1)
            }
        }

    private fun strings(store: Store, sql: String): List<String> =
        store.conn.createStatement().use { s -> s.executeQuery(sql).use { rs -> buildList { while (rs.next()) rs.getString(1)?.let(::add) } } }

    @Test
    fun `the report renders from the seeded scenario and the export leaks nothing`() {
        open().use { s ->
            val t0 = System.nanoTime()
            runBlocking { s.sync() }
            val syncMs = (System.nanoTime() - t0) / 1_000_000
            val papers = scalar(s.store, "SELECT count(*) FROM paper WHERE gone_at IS NULL")
            assertTrue(papers >= minPapers, "seed the scenario first: the harness holds $papers papers, the test needs $minPapers")

            // an appointments sheet over the scenario's juniors and nominees: they are accepted, classified and consenting
            val sheet =
                buildString {
                    appendLine("email,origin,nominated_by,area,ac_email,decision,tier,consent,on_pc_at")
                    strings(s.store, "SELECT email FROM person WHERE email LIKE 'jun%' ORDER BY email").forEach {
                        appendLine("$it,invited,,area,ac1@example.org,accept,junior,yes,")
                    }
                    strings(s.store, "SELECT email FROM person WHERE email LIKE 'nom%' ORDER BY email").take(300)
                        .forEachIndexed { i, e -> appendLine("$e,invited,,area,ac1@example.org,${if (i % 5 == 0) "decline" else "accept"},junior,yes,") }
                }
            assertTrue(Imports(s.store, s.clock).import(ImportKind.APPOINTMENTS, sheet.toByteArray(), "report-appointments.csv") is ImportResult.Accepted)

            val t1 = System.nanoTime()
            val report = ProcessReports.build(s)
            val renderMs = (System.nanoTime() - t1) / 1_000_000
            val md = ReportRender.markdown(report)
            Files.writeString(out.resolve("process-report.md"), md)
            Files.writeString(out.resolve("process-report.html"), ReportRender.html(report))
            println("report[$name]: $papers papers, sync $syncMs ms, report built in $renderMs ms, ${md.length} characters of Markdown")

            report.sections.forEach { sec -> assertTrue(sec.available, "${sec.id} is not available: ${sec.note}") }
            val overview = report.section("overview").tables.first().rows.associate { it[0] to it[1] }
            assertEquals(papers.toString(), overview["papers"])
            assertEquals(scalar(s.store, "SELECT count(*) FROM review WHERE gone_at IS NULL AND rtype <> 5").toString(), overview["reviews (non-AC)"])
            assertEquals(scalar(s.store, "SELECT count(*) FROM review WHERE gone_at IS NULL AND rtype = 5").toString(), overview["metareviews"])
            val nom = report.section("nominations").tables.first { it.title.startsWith("Candidates") }.rows
            assertTrue(nom.sumOf { it[1].toInt() } > 0)
            assertTrue(report.section("progress").tables.first().rows.isNotEmpty())

            // T7: canaries planted in the local mirror (never written to HotCRP), then every identifying string of the mirror is scanned for
            val c = s.store.conn
            c.createStatement().use {
                it.executeUpdate("UPDATE person SET name = coalesce(name, '') || ' CANARY-NAME-$nonce'")
                it.executeUpdate("UPDATE paper SET title = coalesce(title, '') || ' CANARY-TITLE-$nonce'")
                it.executeUpdate("INSERT INTO comment_text(cid,modified_at,text) SELECT cid, 1, 'CANARY-COMMENT-$nonce' FROM comment")
            }
            val ps = Pseudonyms.resolve(s.settings.raw)!!
            val tables = PseudonymousExport.build(s, ps)
            val files = ReportFiles.saveExport(s, out.resolve("export"))!! + ReportFiles.saveReport(s, out.resolve("export"))
            val bytes = files.associateWith { String(Files.readAllBytes(it), Charsets.UTF_8) }
            val rows = tables.sumOf { it.rows.size }
            assertTrue(rows > 0)
            val needles =
                (
                    strings(s.store, "SELECT email FROM person") + strings(s.store, "SELECT name FROM person") + strings(s.store, "SELECT title FROM paper") +
                        strings(s.store, "SELECT email FROM review WHERE email IS NOT NULL")
                ).filter { it.length >= 6 }.distinct() + listOf("CANARY-NAME-$nonce", "CANARY-TITLE-$nonce", "CANARY-COMMENT-$nonce")
            val localParts = strings(s.store, "SELECT email FROM person").map { it.substringBefore('@') }.filter { it.length >= 5 }.distinct()
            val wanted = needles.map { it.lowercase() }.toSet() + localParts.map { it.lowercase() }
            for ((f, text) in bytes) {
                val lower = text.lowercase()
                assertFalse("canary" in lower, "${f.fileName} holds a canary")
                if (f.fileName.toString().endsWith(".csv")) {
                    // a CSV is cells: compare each cell, and each word of a cell, with the set of identifying strings
                    val cells = lower.split(',', '\n', '"')
                    val hit = cells.firstOrNull { it in wanted || it.split(' ').any { w -> w in wanted } }
                    assertTrue(hit == null, "${f.fileName} holds '$hit'")
                    assertFalse('@' in lower, "${f.fileName} holds an address")
                } else {
                    for (n in needles) assertFalse(n.lowercase() in lower, "${f.fileName} holds '$n'")
                }
            }
            println("report[$name]: export ${tables.associate { it.name to it.rows.size }}; scanned ${needles.size} identifying strings in ${files.size} files")
        }
    }
}
