package net.jonbell.pcs.core.session

import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import net.jonbell.pcs.core.assignment.Assignment
import net.jonbell.pcs.core.assignment.AssignmentData
import net.jonbell.pcs.core.assignment.AssignmentInput
import net.jonbell.pcs.core.assignment.AssignmentSettings
import net.jonbell.pcs.core.assignment.SolveReport
import net.jonbell.pcs.core.config.Settings
import net.jonbell.pcs.core.config.SettingsException
import net.jonbell.pcs.core.earlyreject.DecisionArtifact
import net.jonbell.pcs.core.earlyreject.EarlyRejectArtifacts
import net.jonbell.pcs.core.earlyreject.EarlyRejectPlan
import net.jonbell.pcs.core.earlyreject.ErConfig
import net.jonbell.pcs.core.earlyreject.ErReport
import net.jonbell.pcs.core.earlyreject.ErWindow
import net.jonbell.pcs.core.earlyreject.MailDraft
import net.jonbell.pcs.core.hotcrp.HotcrpClient
import net.jonbell.pcs.core.hotcrp.HotcrpLinks
import net.jonbell.pcs.core.imports.Imports
import net.jonbell.pcs.core.readings.Answers
import net.jonbell.pcs.core.secrets.Accounts
import net.jonbell.pcs.core.secrets.Keychain
import net.jonbell.pcs.core.secrets.newDbKey
import net.jonbell.pcs.core.store.Store
import net.jonbell.pcs.core.store.Sync
import net.jonbell.pcs.core.store.SyncCounts
import net.jonbell.pcs.core.time.Clock
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

/** What the early-reject screen can show: the plan and its artifacts, or what blocks it. */
public sealed interface EarlyRejectState {
    public data class Blocked(val reasons: List<String>) : EarlyRejectState

    public data class Ready(
        val report: ErReport,
        val mail: MailDraft,
        val decisions: DecisionArtifact,
        /** Set when the opening has passed and the mirror has no review snapshot at or before it (the chair may backfill the history). */
        val gap: net.jonbell.pcs.core.earlyreject.SnapshotGap? = null,
    ) : EarlyRejectState
}

/** What the assignment screen can show: the solve report, or what blocks it. */
public sealed interface AssignmentState {
    public data class Blocked(val reasons: List<String>) : AssignmentState

    public data class Ready(val report: SolveReport) : AssignmentState
}

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
            Answers(
                net.jonbell.pcs.core.readings.Readings(),
                emptyList(),
                listOf("cannot read the answers file ${settings.answersPath}: ${e.javaClass.simpleName}"),
            )
        }

    /** One full sync (PLAN M3). Concurrent calls wait for the running one rather than start a second. */
    public suspend fun sync(): SyncCounts =
        syncing.withLock {
            val token = token()
            HotcrpClient(settings.hotcrpUrl, token, chunk = settings.syncChunk, concurrency = settings.syncConcurrency, strict = false).use { c ->
                Sync(store, clock).run(c)
            }
        }

    /**
     * Early reject at the clock's now (spec §10.4 E): the candidates, the mail draft, and the decision artifact, or why they
     * can't be computed yet (Q15 or Q16 unresolved, or no window date). Nothing here writes to HotCRP or sends mail.
     */
    public fun earlyReject(): EarlyRejectState {
        val readings = answers().readings
        val blocked =
            listOfNotNull(
                if (readings.q15 == null) "Q15 (what counts as a negative initial review) is unresolved" else null,
                if (readings.q16 == null) "Q16 (a last word before early reject) is unresolved" else null,
                if (settings.phases[net.jonbell.pcs.core.phases.Window.EARLY_REJECT.open] == null) "PCS_PHASE_EARLYREJECT_OPEN is not set" else null,
            )
        if (blocked.isNotEmpty()) return EarlyRejectState.Blocked(blocked)
        val q16 = readings.q16!!
        val window = ErWindow.of(settings.phases, q16, settings.earlyRejectWindowH)!!
        val cfg = ErConfig(readings.q15!!, q16, settings.scoreScale, settings.fieldMerit, settings.reviewsRequired)
        val report = EarlyRejectPlan.compute(store, cfg, window, clock.now())
        return EarlyRejectState.Ready(
            report,
            EarlyRejectArtifacts.mailDraft(report, zoneName = settings.zone.id),
            EarlyRejectArtifacts.decisions(report),
            EarlyRejectPlan.snapshotGap(store, window, clock.now()),
        )
    }

    /**
     * The chair's "Backfill review history" (spec §10.4 E): the throttled `/reviewhistory` backfill at `PCS_HISTORY_RPS`, one request
     * per review not yet read. It never runs by itself; the early-reject screen calls it on the chair's click, then recomputes.
     * Returns the review versions added. Waits for a running sync rather than overlap it.
     */
    public suspend fun backfillReviewHistory(): Int =
        syncing.withLock {
            val token = token()
            HotcrpClient(settings.hotcrpUrl, token, chunk = settings.syncChunk, concurrency = settings.syncConcurrency, strict = false).use { c ->
                net.jonbell.pcs.core.store.Backfill(store, clock).run(c, settings.historyRps)
            }
        }

    /** Drafts the early-reject decisions the chair confirmed (default: every ready paper) as a Writeback artifact; nothing reaches HotCRP until it is confirmed and applied. Returns the artifact's id. */
    public fun draftEarlyRejectDecisions(confirmed: Set<Long>? = null): Long {
        val state = earlyReject() as? EarlyRejectState.Ready ?: throw IllegalStateException("early reject is blocked")
        val art = EarlyRejectArtifacts.decisions(state.report, confirmed ?: state.report.ready.map { it.pid }.toSet())
        return writeback().draft(art.toWriteback())
    }

    /**
     * Reviewing progress and accountability requests at the clock's now (spec §10.4 D). Reads the mirror and the latest
     * appointments sheet; writes nothing to HotCRP, and sends nothing to anyone.
     */
    public fun accountability(
        f: net.jonbell.pcs.core.rules.Faults = net.jonbell.pcs.core.rules.Faults.NONE,
    ): net.jonbell.pcs.core.accountability.AccountabilityReport {
        val readings = answers().readings
        val data = net.jonbell.pcs.core.nominations.NominationData(store, net.jonbell.pcs.core.imports.Imports(store, clock))
        val input = data.input()
        val tags =
            store.conn.createStatement().use { st ->
                st.executeQuery("SELECT lower(email), tags FROM person WHERE gone_at IS NULL").use { rs ->
                    buildMap {
                        while (rs.next()) {
                            put(
                                rs.getString(1),
                                kotlinx.serialization.json.Json.parseToJsonElement(rs.getString(2)).let { e ->
                                    (e as kotlinx.serialization.json.JsonArray).map { t -> (t as kotlinx.serialization.json.JsonPrimitive).content }
                                },
                            )
                        }
                    }
                }
            }
        val tiers = net.jonbell.pcs.core.accountability.Tiers.build(input.sheet, tags, settings.tierTags)
        val cfg = net.jonbell.pcs.core.accountability.AccConfig.from(settings)
        val acc = net.jonbell.pcs.core.accountability.AccLoader.load(store, clock.now(), tiers, settings.fieldMerit)
        val report = data.report(readings, f, settings.venue)
        return net.jonbell.pcs.core.accountability.AccountabilityPlan.compute(acc, cfg, readings, report.obligations, f)
    }

    /**
     * The assignment plan from the mirror and the latest imports (spec §10.4 C, §10.5): the solve report and its bulk-assign CSV, or what blocks it
     * (Q13, Q14 or the nominee questions unresolved, or no affinity import). Nothing here writes to HotCRP.
     */
    public fun assignment(juniorSeats: net.jonbell.pcs.core.rules.JuniorSeats? = null): AssignmentState =
        when (
            val i =
                AssignmentData(store, Imports(store, clock)).build(
                    answers().readings,
                    AssignmentSettings.of(settings).let { a ->
                        juniorSeats?.let { a.copy(juniorSeats = it) }
                            ?: a
                    },
                )
        ) {
            is AssignmentInput.Blocked -> AssignmentState.Blocked(i.reasons)
            is AssignmentInput.Ready -> AssignmentState.Ready(Assignment.report(i.build))
        }

    /** Drafts the plan's bulk-assign CSV as a Writeback artifact; nothing reaches HotCRP until it is dry-run, confirmed and applied. Returns the artifact's id. */
    public fun draftAssignment(juniorSeats: net.jonbell.pcs.core.rules.JuniorSeats? = null): Long {
        val state = assignment(juniorSeats) as? AssignmentState.Ready ?: throw IllegalStateException("the assignment plan is blocked")
        return writeback().draft(state.report.csv.toArtifact())
    }

    /** The discussion dashboard at the clock's now (spec §5): paper risk, AC and reviewer metrics, the overview. Reads the mirror; writes nothing. */
    public fun discussion(): net.jonbell.pcs.core.discussion.DiscussionState = net.jonbell.pcs.core.discussion.DiscussionLoader.state(this)

    /**
     * This chair's public key for screening bundles (X25519, from the OS keychain; created on first use). It is public: the chair gives it to whoever
     * runs `pcs agent bundle --to`, by any channel. The private half never leaves the keychain.
     */
    public fun chairPublicKey(): net.jonbell.pcs.core.bundle.ChairPublicKey =
        net.jonbell.pcs.core.bundle.ChairKeychain.loadOrCreate(keychain, conference.id).publicKey

    /** Imports a screening bundle made for this chair's key. A chair with no key yet has none to open it with, so this never creates one. */
    public fun importBundle(file: ByteArray, source: String): net.jonbell.pcs.core.bundle.BundleImport {
        val me =
            net.jonbell.pcs.core.bundle.ChairKeychain.load(keychain, conference.id)
                ?: throw MissingSecretException(
                    "no chair key in the keychain for ${conference.id}: export your public key first (Settings, or `pcs chair-key`)",
                )
        return net.jonbell.pcs.core.bundle.ScreeningBundles(store, net.jonbell.pcs.core.imports.Imports(store, clock), clock).import(file, me, source)
    }

    /** Writeback (spec §6) for this conference: the only way the app changes HotCRP. */
    public fun writeback(): net.jonbell.pcs.core.writeback.Writeback = net.jonbell.pcs.core.writeback.Writeback(store, clock, settings.hotcrpUrl, token())

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
