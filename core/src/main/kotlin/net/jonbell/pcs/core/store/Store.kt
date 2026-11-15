package net.jonbell.pcs.core.store

import java.nio.file.Path
import java.sql.Connection
import java.sql.DriverManager
import java.sql.SQLException

/**
 * The local store (spec §3, §7): one SQLCipher-encrypted SQLite file per conference. The key
 * comes from the OS keychain (or, for the harness, the environment); opening with the wrong key
 * fails before anything is read.
 */
public class Store private constructor(public val conn: Connection) : AutoCloseable {
    override fun close(): Unit = conn.close()

    public fun <T> tx(block: (Connection) -> T): T {
        conn.autoCommit = false
        try {
            val r = block(conn)
            conn.commit()
            return r
        } catch (e: Throwable) {
            conn.rollback()
            throw e
        } finally {
            conn.autoCommit = true
        }
    }

    public fun count(table: String): Long =
        conn.createStatement().use { s ->
            s.executeQuery("SELECT count(*) FROM $table").use {
                it.next()
                it.getLong(1)
            }
        }

    public companion object {
        private val MIGRATIONS =
            listOf(
                "001-mirror.sql",
                "002-backfill.sql",
                "003-paper-tags.sql",
                "004-imports.sql",
                "005-writeback.sql",
                "006-accountability.sql",
                "007-screening.sql",
            )

        /** Opens (creating if needed) and migrates. Throws [WrongKeyException] if the key doesn't open the file. */
        public fun open(path: Path?, key: String): Store {
            require(key.isNotEmpty()) { "an empty key is not allowed" }
            val target = path?.toString() ?: ":memory:"
            val enc = java.net.URLEncoder.encode(key, Charsets.UTF_8)
            val conn =
                try {
                    DriverManager.getConnection("jdbc:sqlite:file:$target?cipher=sqlcipher&legacy=4&key=$enc")
                } catch (e: SQLException) {
                    throw WrongKeyException("cannot open the store at $target: wrong key, or not a PC Supervisor store")
                }
            try {
                conn.createStatement().use { it.executeQuery("SELECT count(*) FROM sqlite_master").close() }
            } catch (e: SQLException) {
                conn.close()
                throw WrongKeyException("cannot open the store at $target: wrong key, or not a PC Supervisor store")
            }
            val s = Store(conn)
            s.migrate()
            return s
        }
    }

    private fun migrate() {
        val have =
            conn.createStatement().use { s ->
                s.executeQuery("PRAGMA user_version").use {
                    it.next()
                    it.getInt(1)
                }
            }
        for ((i, name) in MIGRATIONS.withIndex()) {
            if (i < have) continue
            val sql = Store::class.java.getResource("/net/jonbell/pcs/schema/$name")!!.readText()
            tx { c ->
                c.createStatement().use { st ->
                    // strip comment lines first: a comment may contain a semicolon
                    sql.lines().filterNot { it.trimStart().startsWith("--") }.joinToString("\n")
                        .split(";").map { it.trim() }.filter { it.isNotEmpty() }.forEach { st.executeUpdate(it) }
                    st.executeUpdate("PRAGMA user_version = ${i + 1}")
                }
            }
        }
    }
}

public class WrongKeyException(message: String) : IllegalStateException(message)
