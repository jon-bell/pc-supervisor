package net.jonbell.pcs.core

import net.jonbell.pcs.core.store.Store
import net.jonbell.pcs.core.store.WrongKeyException
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Files
import java.nio.file.Path

class StoreTest {
    @Test
    fun `the store is encrypted, and the wrong key fails before anything is read`(
        @TempDir dir: Path,
    ) {
        val f = dir.resolve("conf.db")
        Store.open(f, "right key").use { s ->
            s.conn.createStatement().use { it.executeUpdate("INSERT INTO paper(pid,authors,pc_conflicts,first_seen_at,last_seen_at) VALUES(1,'[]','{}',0,0)") }
        }
        assertThrows(WrongKeyException::class.java) { Store.open(f, "wrong key") }
        assertFalse(String(Files.readAllBytes(f), Charsets.ISO_8859_1).contains("SQLite format 3"), "the file is not plaintext SQLite")
        Store.open(f, "right key").use { s -> assertEquals(1L, s.count("paper")) }
    }

    @Test
    fun `migrations run once`(
        @TempDir dir: Path,
    ) {
        val f = dir.resolve("conf.db")
        Store.open(f, "k").close()
        Store.open(f, "k").use { s -> assertEquals(0L, s.count("sync_run")) }
    }
}
