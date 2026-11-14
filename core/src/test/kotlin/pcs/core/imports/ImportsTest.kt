package pcs.core.imports

import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import pcs.core.store.Store
import pcs.core.time.Clock
import pcs.testing.Covers
import java.time.Instant

class ImportsTest {
    private var now: Instant = Instant.parse("2026-12-01T12:00:00Z")
    private val dbDir = java.nio.file.Files.createTempDirectory("pcs-imports-test")
    private val store = Store.open(dbDir.resolve("t.db"), "test-key")
    private val imports = Imports(store, Clock { now })

    @AfterEach
    fun close() {
        store.close()
        dbDir.toFile().deleteRecursively()
    }

    private fun fixture(name: String): ByteArray = ImportsTest::class.java.getResourceAsStream("/pcs/imports/$name")!!.readAllBytes()

    private fun accepted(kind: ImportKind, name: String, mapping: Map<String, String> = emptyMap()): ImportRun =
        (imports.import(kind, fixture(name), name, mapping) as? ImportResult.Accepted)?.run
            ?: error("expected $name to import: " + (imports.import(kind, fixture(name), name, mapping) as ImportResult.Rejected).errors)

    @Test
    @Covers("assume:A4")
    fun `appointments round-trip, and the run records the assumption and its owner`() {
        val run = accepted(ImportKind.APPOINTMENTS, "appointments.csv")
        assertEquals(4, run.rows)
        assertEquals("A4 (owner: PC chairs)", run.assumption)
        val snap = imports.latest(ImportKind.APPOINTMENTS)!!
        assertEquals(listOf("ada.sample@example.org", "ben.sample@example.org", "cara.sample@example.org", "dev.sample@example.org"), snap.rows.map { it.key })
        val ben = snap.byKey["ben.sample@example.org"]!!.data
        assertEquals("nominee", ben["origin"])
        assertEquals("12;40", ben["nominated_by"])
        assertEquals("junior", ben["tier"])
        assertEquals("2026-12-03T09:00", ben["on_pc_at"])
        assertEquals("", snap.byKey["cara.sample@example.org"]!!.data["tier"])
        assertEquals(64, run.fileHash.length)
    }

    @Test
    @Covers("assume:A3")
    fun `the TPMS kinds round-trip and record assumption A3`() {
        val a = accepted(ImportKind.TPMS_ASSIGNMENTS, "tpms-assignments.csv", mapOf("paper" to "Paper ID", "email" to "Reviewer Email"))
        assertEquals(3, a.rows)
        assertEquals("12|ada.sample@example.org", imports.latest(ImportKind.TPMS_ASSIGNMENTS)!!.rows.first().key)
        val s = accepted(ImportKind.TPMS_SCORES, "tpms-scores.csv")
        assertEquals(3, s.rows)
        assertEquals("0.91", imports.latest(ImportKind.TPMS_SCORES)!!.byKey["12|ada.sample@example.org"]!!.data["score"])
        val r = accepted(ImportKind.TPMS_REGISTRATIONS, "tpms-registrations.csv")
        assertEquals(2, r.rows)
        assertEquals("no", imports.latest(ImportKind.TPMS_REGISTRATIONS)!!.byKey["ben.sample@example.org"]!!.data["registered"])
        for (run in listOf(a, s, r)) assertEquals("A3 (owner: process chairs)", run.assumption)
    }

    @Test
    fun `a plain list of registered emails is accepted, and repeated imports are diffed`() {
        accepted(ImportKind.TPMS_REGISTRATIONS, "tpms-registrations.csv")
        val before = imports.latest(ImportKind.TPMS_REGISTRATIONS)!!
        val run = accepted(ImportKind.TPMS_REGISTRATIONS, "tpms-registrations-plain.csv")
        val after = imports.snapshotOf(run)!!
        assertEquals("yes", after.byKey["cara.sample@example.org"]!!.data["registered"])
        assertEquals(before.run.id, imports.before(run)!!.run.id)
        val d = imports.diff(before, after)
        assertEquals(listOf("cara.sample@example.org"), d.added)
        assertEquals(listOf("ben.sample@example.org"), d.removed)
        assertEquals(listOf("ada.sample@example.org"), d.changed)
    }

    @Test
    fun `screening bundle and refcheck round-trip`() {
        assertEquals(2, accepted(ImportKind.SCREENING_BUNDLE, "screening-bundle.csv").rows)
        assertEquals(2, accepted(ImportKind.REFCHECK, "refcheck.csv").rows)
        val f = imports.latest(ImportKind.SCREENING_BUNDLE)!!.byKey["40|anonymity|self-reference"]!!.data
        assertEquals("""[{"page":1,"quote":"in our earlier work"}]""", f["anchors"])
        assertNull(ImportKind.SCREENING_BUNDLE.assumption)
    }

    @Test
    fun `a malformed CSV gives a row-level report and imports nothing, and the earlier version stays current`() {
        val good = accepted(ImportKind.APPOINTMENTS, "appointments.csv")
        now = now.plusSeconds(3600)
        val r = imports.import(ImportKind.APPOINTMENTS, fixture("appointments-bad.csv"), "appointments-bad.csv") as ImportResult.Rejected
        val at = r.errors.map { it.line to it.column }.toSet()
        // line 3: bad email; line 4: origin, nominated_by, consent, on_pc_at; line 5: duplicate key; line 6: too few fields
        assertTrue((3 to "email") in at, "$at")
        for (c in listOf("origin", "nominated_by", "consent", "on_pc_at")) assertTrue((4 to c) in at, "$c in $at")
        assertTrue(r.errors.any { it.line == 5 && "duplicate of line 2" in it.message })
        assertTrue(r.errors.any { it.line == 6 && "expected 9 fields" in it.message })
        // the good rows of the bad file (line 2) were not imported either
        assertEquals(good.id, imports.latest(ImportKind.APPOINTMENTS)!!.run.id)
        assertEquals(4L, count("SELECT count(*) FROM import_row"))
        // the attempt itself is on record, with its errors, and no rows
        val runs = imports.runs(ImportKind.APPOINTMENTS)
        assertEquals(listOf(true, false), runs.map { it.accepted })
        assertEquals(r.errors, runs.last().errors)
        assertEquals(0, runs.last().rows)
    }

    @Test
    fun `bad scores, bad structure, and bad mappings are all rejected with row-level reasons`() {
        val s = imports.import(ImportKind.TPMS_SCORES, fixture("tpms-scores-bad.csv"), "s") as ImportResult.Rejected
        assertEquals(listOf(3, 4, 5), s.errors.map { it.line }.distinct())
        assertTrue(s.errors.any { it.line == 3 && it.column == "score" })
        assertTrue(s.errors.any { it.line == 4 && it.column == "paper" })

        fun rejected(kind: ImportKind, csv: String, mapping: Map<String, String> = emptyMap()) =
            (imports.import(kind, csv.toByteArray(), "x", mapping) as ImportResult.Rejected).errors

        assertTrue(rejected(ImportKind.TPMS_SCORES, "paper,email\n1,a@example.org\n").single().message.contains("missing required column 'score'"))
        assertTrue(rejected(ImportKind.TPMS_SCORES, "paper,email,score,tpyo\n").single().message == "unknown column")
        assertTrue(rejected(ImportKind.TPMS_SCORES, "paper,email,score\n1,\"a@example.org,0.5\n").single().message.contains("unterminated"))
        assertTrue(rejected(ImportKind.TPMS_SCORES, "").single().message.contains("empty"))
        assertTrue(rejected(ImportKind.TPMS_SCORES, "paper,email,score\n", mapOf("nope" to "x")).single().message.contains("not a tpms-scores column"))
        assertTrue(rejected(ImportKind.TPMS_ASSIGNMENTS, "pid,who\n1,a@example.org\n").any { it.message.contains("missing required column 'paper'") })
        assertEquals(0L, count("SELECT count(*) FROM import_row"))
        val bad = imports.import(ImportKind.TPMS_SCORES, byteArrayOf(0x70, 0xC3.toByte(), 0x28), "x") as ImportResult.Rejected
        assertTrue(bad.errors.single().message.contains("UTF-8"))
    }

    @Test
    fun `what did the sheet say on day X, at two clock values`() {
        val t1 = Instant.parse("2026-12-01T12:00:00Z")
        val t2 = Instant.parse("2026-12-10T12:00:00Z")
        now = t1
        val v1 = accepted(ImportKind.APPOINTMENTS, "appointments.csv")
        now = t2
        val v2 = accepted(ImportKind.APPOINTMENTS, "appointments-v2.csv")
        assertNotEquals(v1.fileHash, v2.fileHash)
        assertEquals(2, imports.runs(ImportKind.APPOINTMENTS).size)

        // The clock at day 3 (PCS_NOW = 2026-12-04): the first version.
        val day3 = imports.asOf(ImportKind.APPOINTMENTS, Instant.parse("2026-12-04T00:00:00Z"))!!
        assertEquals(v1.id, day3.run.id)
        assertEquals("pending", day3.byKey["cara.sample@example.org"]!!.data["decision"])
        assertNull(day3.byKey["eve.sample@example.org"])
        // The clock at day 10 (PCS_NOW = t2): the second.
        now = t2
        val latest = imports.latest(ImportKind.APPOINTMENTS)!!
        assertEquals(v2.id, latest.run.id)
        assertEquals("accept", latest.byKey["cara.sample@example.org"]!!.data["decision"])
        assertEquals("pending", latest.byKey["eve.sample@example.org"]!!.data["decision"])
        // The instant of an import sees that import; one second before sees the previous one; before any, nothing.
        assertEquals(v2.id, imports.asOf(ImportKind.APPOINTMENTS, t2)!!.run.id)
        assertEquals(v1.id, imports.asOf(ImportKind.APPOINTMENTS, t2.minusSeconds(1))!!.run.id)
        assertNull(imports.asOf(ImportKind.APPOINTMENTS, t1.minusSeconds(1)))
        val d = imports.diff(day3, latest)
        assertEquals(listOf("eve.sample@example.org"), d.added)
        assertEquals(listOf("cara.sample@example.org"), d.changed)
    }

    @Test
    fun `re-importing identical content is still a new version`() {
        val a = accepted(ImportKind.TPMS_SCORES, "tpms-scores.csv")
        now = now.plusSeconds(60)
        val b = accepted(ImportKind.TPMS_SCORES, "tpms-scores.csv")
        assertEquals(a.fileHash, b.fileHash)
        assertNotEquals(a.id, b.id)
        assertTrue(imports.diff(imports.snapshotOf(a), imports.snapshotOf(b)!!).isEmpty)
    }

    @Test
    @Covers("prop:M2", "assume:A3", "assume:A4")
    fun `an import older than its freshness is reported stale, and a kind never imported is reported missing`() {
        val t0 = Instant.parse("2026-12-01T12:00:00Z")
        now = t0
        accepted(ImportKind.APPOINTMENTS, "appointments.csv")
        accepted(ImportKind.TPMS_SCORES, "tpms-scores.csv")
        val limits = mapOf(ImportKind.APPOINTMENTS to 7)

        fun state(k: ImportKind) = imports.staleness(limits).first { it.kind == k }.state
        now = t0.plusSeconds(7 * 86_400L - 1)
        assertEquals(Freshness.FRESH, state(ImportKind.APPOINTMENTS))
        now = t0.plusSeconds(7 * 86_400L)
        assertEquals(Freshness.FRESH, state(ImportKind.APPOINTMENTS), "exactly at the limit is not yet stale")
        now = t0.plusSeconds(7 * 86_400L + 1)
        assertEquals(Freshness.STALE, state(ImportKind.APPOINTMENTS))
        assertTrue(imports.staleness(limits).first { it.kind == ImportKind.APPOINTMENTS }.describe().contains("STALE"))
        // the default for tpms-scores is 30 days; the setting overrides it
        assertEquals(Freshness.FRESH, state(ImportKind.TPMS_SCORES))
        assertEquals(Freshness.STALE, imports.staleness(mapOf(ImportKind.TPMS_SCORES to 1)).first { it.kind == ImportKind.TPMS_SCORES }.state)
        assertEquals(Freshness.MISSING, state(ImportKind.REFCHECK))
        // a fresh re-import clears the staleness
        accepted(ImportKind.APPOINTMENTS, "appointments-v2.csv")
        assertEquals(Freshness.FRESH, state(ImportKind.APPOINTMENTS))
        // a rejected attempt does not refresh a stale sheet
        now = now.plusSeconds(30 * 86_400L)
        imports.import(ImportKind.APPOINTMENTS, fixture("appointments-bad.csv"), "bad")
        assertEquals(Freshness.STALE, state(ImportKind.APPOINTMENTS))
    }

    private fun count(sql: String): Long =
        store.conn.createStatement().use { s ->
            s.executeQuery(sql).use {
                it.next()
                it.getLong(1)
            }
        }
}
