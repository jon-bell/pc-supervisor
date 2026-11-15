package net.jonbell.pcs.core.bundle

import net.jonbell.pcs.core.imports.ImportKind
import net.jonbell.pcs.core.imports.ImportResult
import net.jonbell.pcs.core.imports.ImportRun
import net.jonbell.pcs.core.imports.Imports
import net.jonbell.pcs.core.store.Store
import net.jonbell.pcs.core.time.Clock

/** The outcome of importing a bundle file. */
public sealed interface BundleImport {
    public data class Imported(val hash: String, val run: ImportRun, val payload: BundlePayload) : BundleImport

    /** The same content address was imported before; nothing changed. */
    public data class AlreadyImported(val hash: String, val runId: Long) : BundleImport

    /** The findings did not pass the import kind's validation; nothing was stored. */
    public data class Rejected(val hash: String, val problems: List<String>) : BundleImport
}

/**
 * Imports screening bundles into the encrypted store (spec §10.3, §11). The findings become a version of
 * the `screening-bundle` import kind (so freshness, diffs and keys work as for every import), and the
 * manifest, the qualification records and the summaries are kept beside it by content address, inside
 * the same SQLCipher store. The key is used to open the file and is never stored.
 */
public class ScreeningBundles(private val store: Store, private val imports: Imports, private val clock: Clock) {
    init {
        store.tx { c ->
            c.createStatement().use {
                it.executeUpdate(
                    "CREATE TABLE IF NOT EXISTS screening_bundle(hash TEXT PRIMARY KEY, run_id INTEGER NOT NULL, imported_at INTEGER NOT NULL, payload TEXT NOT NULL)",
                )
            }
        }
    }

    public fun import(file: ByteArray, key: BundleKey, source: String): BundleImport {
        val payload = BundleCodec.decrypt(file, key)
        val hash = payload.hash()
        existing(hash)?.let { return BundleImport.AlreadyImported(hash, it) }
        return when (val r = imports.import(ImportKind.SCREENING_BUNDLE, payload.importCsv().toByteArray(Charsets.UTF_8), source)) {
            is ImportResult.Rejected -> BundleImport.Rejected(hash, r.errors.map { "line ${it.line}: ${it.message}" })
            is ImportResult.Accepted -> {
                store.tx { c ->
                    c.prepareStatement("INSERT INTO screening_bundle(hash,run_id,imported_at,payload) VALUES(?,?,?,?)").use { st ->
                        st.setString(1, hash)
                        st.setLong(2, r.run.id)
                        st.setLong(3, clock.now().epochSecond)
                        st.setString(4, String(payload.bytes(), Charsets.UTF_8))
                        st.executeUpdate()
                    }
                }
                BundleImport.Imported(hash, r.run, payload)
            }
        }
    }

    private fun existing(hash: String): Long? =
        store.conn.prepareStatement("SELECT run_id FROM screening_bundle WHERE hash=?").use { st ->
            st.setString(1, hash)
            st.executeQuery().use { rs -> if (rs.next()) rs.getLong(1) else null }
        }

    /** The payload of the most recently imported bundle, or null. */
    public fun latest(): BundlePayload? =
        store.conn.createStatement().use { s ->
            s.executeQuery("SELECT payload FROM screening_bundle ORDER BY imported_at DESC, run_id DESC LIMIT 1").use { rs ->
                if (rs.next()) BundlePayload.parse(rs.getString(1).toByteArray(Charsets.UTF_8)) else null
            }
        }

    /** What an AC may be shown for [pid] from the latest bundle: verified findings only. */
    public fun visibleFor(pid: String): List<BundleFinding> = latest()?.visible?.filter { it.pid == pid }.orEmpty()
}
