package pcs.cli

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonPrimitive
import pcs.core.config.Settings
import pcs.core.config.SettingsException
import pcs.core.hotcrp.HotcrpClient
import java.nio.file.Files
import java.nio.file.Path
import kotlin.system.exitProcess

/** `pcs`: `core` without a window (spec §4). */
fun main(args: Array<String>) {
    when (args.firstOrNull()) {
        "probe" -> probe()
        "sync" -> sync()
        "wipe" -> wipe()
        else -> {
            System.err.println("usage: pcs probe | sync | wipe")
            exitProcess(2)
        }
    }
}

/**
 * PLAN M0: a read-only shape report of the instance. It prints counts, keys, field UIDs and
 * value ranges, tag names, and setting presence, and **no content**: no titles, names, emails,
 * or text.
 */
fun probe() {
    val env = System.getenv()
    val conf = env["PCS_CONF"]?.let { Path.of(it) }?.takeIf(Files::exists)?.let(Settings::readConf).orEmpty()
    val probeEnv = env + mapOf("PCS_ANSWERS" to (env["PCS_ANSWERS"] ?: "unused-by-probe"))
    val settings =
        try {
            Settings.load(probeEnv, conf).getOrThrow()
        } catch (e: SettingsException) {
            System.err.println(e.message)
            exitProcess(1)
        }
    val token =
        env["PCS_HOTCRP_TOKEN"]?.takeIf { settings.isLocalHarness }
            ?: error("the token comes from the OS keychain for a real instance (not yet wired; M4); set PCS_HOTCRP_TOKEN only for the local harness")
    HotcrpClient(settings.hotcrpUrl, token, strict = false).use { c ->
        runBlocking {
            val pc = c.pc()
            val rows = c.assignments()
            val pids = c.paperIds()
            val reviews = c.reviews(pids)
            val comments = c.comments(pids)
            println("# pcs probe: shape report (no content)")
            println("papers: ${pids.size}")
            println("pc members: ${pc.size}; roles: ${pc.flatMap { it.roles }.groupingBy { it }.eachCount()}")
            println("user tags present: ${pc.flatMap { it.tags }.distinct().sorted()}")
            println("assignments by action: ${rows.groupingBy { it.action }.eachCount()}")
            println("reviews by rtype: ${reviews.groupingBy { it.rtype }.eachCount()}; by status: ${reviews.groupingBy { it.status }.eachCount()}")
            println(
                "review-form fields: " +
                    reviews.flatMap { it.fields.keys }.distinct().sorted().joinToString { uid ->
                        val nums = reviews.mapNotNull { (it.fields[uid] as? JsonPrimitive)?.content?.toIntOrNull() }
                        if (nums.isEmpty()) "$uid (text)" else "$uid (${nums.min()}..${nums.max()})"
                    },
            )
            println(
                "reviews with ratings: ${reviews.count {
                    it.ratings.isNotEmpty()
                }}; rating flags seen: ${reviews.flatMap { it.ratings }.distinct().sorted()}",
            )
            println(
                "modified_at on complete reviews: ${reviews.count {
                    it.status == "complete" && it.modifiedAt != null
                }}/${reviews.count { it.status == "complete" }}",
            )
            println("comments: ${comments.size}; with modified_at: ${comments.count { it.modifiedAt != null }}; responses: ${comments.count { it.response }}")
            val st = c.settings()
            val keys =
                listOf(
                    "review_rating",
                    "review_rating_visibility",
                    "tag_hidden",
                    "tag_readonly",
                    "tag_pc_open",
                    "tag_admin_open",
                    "tag_visibility_conflict",
                    "comment_allow_always",
                    "rev_blind",
                    "sub_blind",
                )
            println("settings spec §11 depends on: " + keys.joinToString { k -> "$k=${st[k] ?: "absent"}" })
            println(
                "contract drift (keys or types we didn't expect): ${if (c.drift.isEmpty()) {
                    "none"
                } else {
                    c.drift.size.toString() + " problems:\n  " +
                        c.drift.distinct().joinToString(
                            "\n  ",
                        )
                }
                }",
            )
        }
    }
}

private fun harnessSettings(): Pair<Settings, String> {
    val env = System.getenv()
    val conf = env["PCS_CONF"]?.let { Path.of(it) }?.takeIf(Files::exists)?.let(Settings::readConf).orEmpty()
    val settings =
        try {
            Settings.load(env + mapOf("PCS_ANSWERS" to (env["PCS_ANSWERS"] ?: "unused")), conf).getOrThrow()
        } catch (e: SettingsException) {
            System.err.println(e.message)
            exitProcess(1)
        }
    val token =
        env["PCS_HOTCRP_TOKEN"]?.takeIf { settings.isLocalHarness }
            ?: error("the token comes from the OS keychain for a real instance (not yet wired; M4); set PCS_HOTCRP_TOKEN only for the local harness")
    return settings to token
}

private fun dbPath(s: Settings): Path = s.dbPath ?: Path.of(System.getProperty("user.home"), ".local/share/pc-supervisor/${s.hotcrpUrl.host}.db")

/** PLAN M3: one full sync into the encrypted store. */
fun sync() {
    val (settings, token) = harnessSettings()
    val key =
        System.getenv("PCS_DB_KEY")?.takeIf { settings.isLocalHarness }
            ?: error("the DB key comes from the OS keychain (M4); PCS_DB_KEY only for the local harness")
    val path = dbPath(settings)
    Files.createDirectories(path.parent)
    pcs.core.store.Store.open(path, key).use { store ->
        HotcrpClient(settings.hotcrpUrl, token, chunk = settings.syncChunk, concurrency = settings.syncConcurrency, strict = false).use { c ->
            val counts = runBlocking { pcs.core.store.Sync(store, pcs.core.time.Clock.fromSettings(settings.now)).run(c) }
            println("synced into $path: new ${counts.newRows}, changed ${counts.changed}, gone ${counts.gone}")
            if (c.drift.isNotEmpty()) println("contract drift recorded in sync_run: ${c.drift.size} problems")
        }
    }
}

/** Deletes the local store (spec §7). */
fun wipe() {
    val (settings, _) = harnessSettings()
    val path = dbPath(settings)
    if (Files.deleteIfExists(path)) println("deleted $path") else println("nothing at $path")
}
