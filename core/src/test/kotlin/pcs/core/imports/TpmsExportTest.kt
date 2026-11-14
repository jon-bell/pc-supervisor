package pcs.core.imports

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import pcs.core.store.Store
import pcs.core.time.Clock
import java.nio.file.Files
import java.nio.file.Path
import java.time.Instant

class TpmsExportTest {
    @Test
    fun `the export writes the PC list, conflicts, load groups by tier, and the reviews-per-paper target`(
        @TempDir dir: Path,
    ) {
        val now = Instant.parse("2026-12-05T00:00:00Z")
        Store.open(dir.resolve("t.db"), "k").use { store ->
            val t = now.epochSecond
            for ((email, name) in listOf(
                "ada.sample@example.org" to "Ada Sample",
                "ben.sample@example.org" to "Ben, Sample",
                "fay.sample@example.org" to "Fay Sample",
            )) {
                store.conn.prepareStatement("INSERT INTO person(email,name,roles,tags,first_seen_at,last_seen_at) VALUES(?,?,?,?,?,?)").use {
                    it.setString(1, email)
                    it.setString(2, name)
                    it.setString(3, "[\"pc\"]")
                    it.setString(4, "[]")
                    it.setLong(5, t)
                    it.setLong(6, t)
                    it.executeUpdate()
                }
            }
            store.conn.createStatement().use {
                it.executeUpdate(
                    "INSERT INTO paper(pid,title,authors,pc_conflicts,first_seen_at,last_seen_at) VALUES(12,'T','[]','{\"ben.sample@example.org\":\"author\",\"outsider@example.org\":\"x\"}',$t,$t)",
                )
                it.executeUpdate("INSERT INTO paper(pid,title,authors,pc_conflicts,first_seen_at,last_seen_at) VALUES(40,'T','[]','{}',$t,$t)")
            }
            val imports = Imports(store, Clock { now.minusSeconds(60) })
            imports.import(ImportKind.APPOINTMENTS, TpmsExportTest::class.java.getResourceAsStream("/pcs/imports/appointments.csv")!!.readAllBytes(), "a")
            val r = TpmsExport(store, imports).write(dir.resolve("out"), mapOf("senior" to 15, "junior" to 8), 3, now)
            assertEquals(3, r.pcMembers)
            assertEquals(1, r.conflicts)
        }
        val out = dir.resolve("out")
        assertEquals(
            "email,name\nada.sample@example.org,Ada Sample\nben.sample@example.org,\"Ben, Sample\"\nfay.sample@example.org,Fay Sample\n",
            Files.readString(out.resolve("pc.csv")),
        )
        assertEquals("paper,email\n12,ben.sample@example.org\n", Files.readString(out.resolve("conflicts.csv")))
        // fay has no appointments row, so she is senior
        assertEquals(
            "email,tier,max_load\nada.sample@example.org,senior,15\nfay.sample@example.org,senior,15\n",
            Files.readString(out.resolve("load-senior-max15.csv")),
        )
        assertEquals("email,tier,max_load\nben.sample@example.org,junior,8\n", Files.readString(out.resolve("load-junior-max8.csv")))
        assertEquals("3\n", Files.readString(out.resolve("reviews-per-paper.txt")))
    }
}
