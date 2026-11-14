package pcs.core.session

import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import pcs.core.config.Settings
import pcs.core.config.SettingsException
import pcs.core.hotcrp.HotcrpClient
import pcs.core.hotcrp.HotcrpLinks
import pcs.core.readings.Answers
import pcs.core.secrets.Accounts
import pcs.core.secrets.Keychain
import pcs.core.secrets.newDbKey
import pcs.core.store.Store
import pcs.core.store.Sync
import pcs.core.store.SyncCounts
import pcs.core.time.Clock
import java.nio.file.Files
import java.nio.file.NoSuchFileException
import java.nio.file.Path
import kotlin.io.path.extension
import kotlin.io.path.listDirectoryEntries
import kotlin.io.path.nameWithoutExtension

/**
 * One conference: a conference file (`<id>.conf`, spec §4.1) with its own encrypted store. The
 * id names the keychain entries, so two conferences never share a key.
 */
public data class Conference(val id: String, val confPath: Path?, val settings: Result<Settings>) {
    /** Where its store lives: `PCS_DB_PATH`, else `<app data>/<id>.db`. */
    public fun dbPath(env: Map<String, String>): Path? = settings.getOrNull()?.let { it.dbPath ?: AppDirs.data(env).resolve("$id.db") }

    /** Every settings problem at once, or empty. */
    public val problems: List<String> get() = (settings.exceptionOrNull() as? SettingsException)?.problems ?: listOfNotNull(settings.exceptionOrNull()?.message)
}

/** The OS's per-user directories for PC Supervisor; never inside the repo or a synced folder by default. */
public object AppDirs {
    public fun data(env: Map<String, String>): Path {
        val home = Path.of(System.getProperty("user.home"))
        val os = System.getProperty("os.name").lowercase()
        return when {
            os.contains("mac") -> home.resolve("Library/Application Support/PC Supervisor")
            os.contains("win") -> Path.of(env["APPDATA"] ?: home.resolve("AppData/Roaming").toString()).resolve("PC Supervisor")
            else -> Path.of(env["XDG_DATA_HOME"] ?: home.resolve(".local/share").toString()).resolve("pc-supervisor")
        }
    }

    /** The conference files: `PCS_CONFERENCES`, else `<app data>/conferences`. */
    public fun conferences(env: Map<String, String>): Path =
        env["PCS_CONFERENCES"]?.takeIf { it.isNotEmpty() }?.let(Path::of) ?: data(env).resolve("conferences")
}

/** The conference picker's source: every `*.conf` in the conferences directory (spec §4.1). */
public object Conferences {
    public fun list(env: Map<String, String>): List<Conference> {
        val dir = AppDirs.conferences(env)
        val files =
            try {
                dir.listDirectoryEntries().filter { it.extension == "conf" && Files.isRegularFile(it) }.sortedBy { it.fileName.toString() }
            } catch (e: NoSuchFileException) {
                emptyList()
            }
        return files.map { load(it, env) }
    }

    public fun load(confPath: Path, env: Map<String, String>): Conference {
        val conf = Settings.readConf(confPath)
        return Conference(confPath.nameWithoutExtension, confPath, Settings.load(env, conf))
    }
}

/** A secret the session needs is not in the keychain. The message names the account, never a value. */
public class MissingSecretException(message: String) : IllegalStateException(message)

/** What the last sync recorded (spec §3 `sync_run`). */
public data class SyncRun(val finishedAt: java.time.Instant, val counts: String, val driftProblems: Int)

/**
 * An open conference: its store, unlocked with the DB key from the keychain, and the means to
 * sync it. The token and the key stay in here; nothing hands them to the caller.
 */
public class Session private constructor(
    public val conference: Conference,
    public val settings: Settings,
    public val store: Store,
    private val keychain: Keychain,
    private val env: Map<String, String>,
    public val clock: Clock,
) : AutoCloseable {
    private val syncing = Mutex()

    public val links: HotcrpLinks = HotcrpLinks(settings.hotcrpUrl)

    /** The answers file's readings (spec §4.1), read fresh each time so an edit shows on reopen. */
    public fun answers(): Answers =
        try {
            Answers.read(settings.answersPath)
        } catch (e: java.io.IOException) {
            Answers(pcs.core.readings.Readings(), emptyList(), listOf("cannot read the answers file ${settings.answersPath}: ${e.javaClass.simpleName}"))
        }

    /** One full sync (PLAN M3). Concurrent calls wait for the running one rather than start a second. */
    public suspend fun sync(): SyncCounts =
        syncing.withLock {
            val token = token()
            HotcrpClient(settings.hotcrpUrl, token, chunk = settings.syncChunk, concurrency = settings.syncConcurrency, strict = false).use { c ->
                Sync(store, clock).run(c)
            }
        }

    /** Writeback (spec §6) for this conference: the only way the app changes HotCRP. */
    public fun writeback(): pcs.core.writeback.Writeback = pcs.core.writeback.Writeback(store, clock, settings.hotcrpUrl, token())

    public fun lastSync(): SyncRun? =
        store.conn.createStatement().use { s ->
            s.executeQuery("SELECT finished_at, counts, errors FROM sync_run WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 1").use {
                if (!it.next()) {
                    null
                } else {
                    SyncRun(java.time.Instant.ofEpochSecond(it.getLong(1)), it.getString(2) ?: "", it.getString(3)?.lines()?.count { l -> l.isNotBlank() } ?: 0)
                }
            }
        }

    private fun token(): String =
        keychain.read(Accounts.token(conference.id))
            ?: env["PCS_HOTCRP_TOKEN"]?.takeIf { settings.isLocalHarness }
            ?: throw MissingSecretException(
                "no HotCRP token in the keychain for ${conference.id}: run `pcs secret ${conference.id}` and paste the chair token",
            )

    override fun close(): Unit = store.close()

    public companion object {
        /**
         * Opens the conference's store with the DB key from [keychain]. A conference with no store
         * yet gets a fresh random key, written to the keychain before the store is created. The
         * environment is read for secrets only when the HotCRP URL is the local harness.
         */
        public fun open(conference: Conference, keychain: Keychain, env: Map<String, String>): Session {
            val settings = conference.settings.getOrThrow()
            val path = conference.dbPath(env)!!
            val key =
                keychain.read(Accounts.dbKey(conference.id))
                    ?: env["PCS_DB_KEY"]?.takeIf { settings.isLocalHarness }
                    ?: if (Files.exists(path)) {
                        throw MissingSecretException("the store for ${conference.id} exists at $path, but its key is not in the keychain")
                    } else {
                        newDbKey().also { keychain.write(Accounts.dbKey(conference.id), it) }
                    }
            Files.createDirectories(path.toAbsolutePath().parent)
            val store = Store.open(path, key)
            return Session(conference, settings, store, keychain, env, Clock.fromSettings(settings.now))
        }
    }
}
