package pcs.core.config

import pcs.core.imports.ImportKind
import pcs.core.phases.Phases
import pcs.core.rules.ScoreScale
import pcs.core.rules.Venue
import java.net.URI
import java.nio.file.Files
import java.nio.file.Path
import java.time.Instant
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.format.DateTimeParseException

/**
 * Operational settings (spec §4.1): `PCS_*` keys from the environment, else from the
 * conference file `pcs.conf`. Policy choices are not settings; they are readings in the
 * answers file. Secrets come from the OS keychain, except that `PCS_HOTCRP_TOKEN` and
 * `PCS_DB_KEY` are read from the environment when the HotCRP URL is localhost (tests, CI).
 */
public data class Settings(
    val hotcrpUrl: URI,
    val answersPath: Path,
    val zone: ZoneId,
    val phases: Map<String, Instant>,
    val now: Instant?,
    val acRole: String,
    val tierTags: Map<String, String>,
    val fieldMerit: String,
    val fieldExpertise: String,
    val meritAcceptMin: Int,
    val expertiseOkMin: Int,
    val reviewsRequired: Int,
    /** Hours of Q16's last-word window when `PCS_PHASE_EARLYREJECT_CLOSE` doesn't fix its end (`PCS_EARLYREJECT_WINDOW_H`). */
    val earlyRejectWindowH: Int,
    /** Merit values on the model's score scale (`PCS_SCORE_MAP`), for Q15. */
    val scoreScale: ScoreScale,
    val dbPath: Path?,
    val syncIntervalMin: Int,
    val syncChunk: Int,
    val syncConcurrency: Int,
    val historyRps: Int,
    val forceShow: Boolean,
    val loadMax: Map<String, Int>,
    /** Days after which an import of each kind is stale (`PCS_IMPORT_FRESH_<KIND>_DAYS`, spec §10.3). */
    val importFreshDays: Map<ImportKind, Int>,
    val raw: Map<String, String>,
    /** The tag a chair puts on a set that needs the chairs' attention (`PCS_TAG_CHAIR_ATTENTION`, spec §6). */
    val tagChairAttention: String = "chair-attention",
    /** The venue's numbers for the model (`PCS_NOMINEES_MAX`, `PCS_PATTERN_MIN`, `PCS_ACC_GRACE_H`). */
    val venue: Venue = Venue(),
) {
    public val isLocalHarness: Boolean get() = isLocalhost(hotcrpUrl)

    /** The phase logic over [phases] (spec §10.1). Ask it about `Clock.now()`. */
    public val phaseModel: Phases get() = Phases(phases)

    public companion object {
        /** Keys the loader knows, beyond the patterned ones (`PCS_PHASE_*`, `PCS_RULE_*`, ...). */
        public val KNOWN: Set<String> =
            setOf(
                "PCS_HOTCRP_URL",
                "PCS_HOTCRP_TOKEN",
                "PCS_ANSWERS",
                "PCS_FORCE_SHOW",
                "PCS_TZ",
                "PCS_NOW",
                "PCS_AC_ROLE",
                "PCS_TIER_TAGS",
                "PCS_FIELD_MERIT",
                "PCS_FIELD_EXPERTISE",
                "PCS_MERIT_ACCEPT_MIN",
                "PCS_EXPERTISE_OK_MIN",
                "PCS_REVIEWS_REQUIRED",
                "PCS_DB_PATH",
                "PCS_DB_KEY",
                "PCS_SYNC_INTERVAL_MIN",
                "PCS_SYNC_CHUNK",
                "PCS_SYNC_CONCURRENCY",
                "PCS_HISTORY_RPS",
                "PCS_PSEUDONYM_KEY",
                "PCS_CYCLE_MAX_K",
                "PCS_EARLYREJECT_WINDOW_H",
                "PCS_SCORE_MAP",
                "PCS_REQUEST_DUE_H",
                "PCS_NOMINEES_MAX",
                "PCS_PATTERN_MIN",
                "PCS_ACC_GRACE_H",
                "PCS_FIELD_WEAKNESS",
                "PCS_FIELDS_REQUIRED",
                "PCS_SOLVER_TOPK",
                "PCS_SOLVER_HARD",
                "PCS_SOLVER_SLOT_BONUS",
                "PCS_CYCLE_REPAIR_MAX_ROUNDS",
                "PCS_ASSIGN_ROUND",
                "PCS_M3_AFFINITY_MIN",
                "PCS_M3_MIN_EXCLUDED",
                "PCS_M3_MIN_SHARE",
                "PCS_M3_SIGMA",
                "PCS_CONFERENCES",
            )
        public val PATTERNS: List<Regex> =
            listOf(
                Regex("PCS_PHASE_[A-Z_]+"),
                Regex("PCS_CRITERION_[0-9]+"),
                Regex("PCS_IMPORT_FRESH_[A-Z_]+_DAYS"),
                Regex("PCS_RULE_[A-Z_]+_WEIGHT"),
                Regex("PCS_THRESH_[A-Z_]+"),
                Regex("PCS_LOAD_[A-Z]+_MAX"),
                Regex("PCS_AFFINITY_WEIGHT_[A-Z_]+"),
                Regex("PCS_TAG_[A-Z_]+"),
                Regex("PCS_AGENT_[A-Z_]+"),
                // Screening engines (agent.md §4.3): PCS_ENGINES, one PCS_ENGINE_<id>_* block per engine, PCS_CHECK_<check>_ENGINE routing.
                Regex("PCS_ENGINES"),
                Regex("PCS_ENGINE_[A-Za-z0-9-]+_[A-Z_]+"),
                Regex("PCS_CHECK_[a-z0-9.-]+_ENGINE"),
            )

        public fun isKnown(key: String): Boolean = key in KNOWN || PATTERNS.any { it.matches(key) }

        public fun isLocalhost(u: URI): Boolean = u.host == "127.0.0.1" || u.host == "localhost"

        /** Read `KEY=value` lines; `#` starts a comment. */
        public fun readConf(path: Path): Map<String, String> =
            Files.readAllLines(path).mapNotNull { raw ->
                val line = raw.substringBefore('#').trim()
                if (line.isEmpty() || '=' !in line) null else line.substringBefore('=').trim() to line.substringAfter('=').trim()
            }.toMap()

        /** Environment wins over the conference file. Empty values count as unset. */
        public fun load(env: Map<String, String>, conf: Map<String, String> = emptyMap()): Result<Settings> {
            val m = (conf + env.filterKeys { it.startsWith("PCS_") }).filterValues { it.isNotEmpty() }
            val errors = mutableListOf<String>()
            for (k in m.keys) if (!isKnown(k)) errors += "$k: unknown setting"

            fun <T> parse(key: String, default: T?, f: (String) -> T): T? {
                val v = m[key] ?: return default.also { if (it == null) errors += "$key: required" }
                return try {
                    f(v)
                } catch (e: IllegalArgumentException) {
                    errors += "$key: ${e.message}"
                    null
                }
            }

            fun int(key: String, default: Int, min: Int = 0): Int =
                parse(key, default) { s -> s.toIntOrNull()?.takeIf { it >= min } ?: throw IllegalArgumentException("not an integer ≥ $min: $s") } ?: default

            fun bool(key: String, default: Boolean): Boolean =
                parse(key, default) { s -> s.toBooleanStrictOrNull() ?: throw IllegalArgumentException("not true or false: $s") } ?: default

            val url =
                parse<URI>("PCS_HOTCRP_URL", null) { s ->
                    val u =
                        try {
                            URI(s)
                        } catch (e: java.net.URISyntaxException) {
                            throw IllegalArgumentException("not a URL: $s")
                        }
                    require(u.scheme == "https" || (u.scheme == "http" && isLocalhost(u))) { "must be https (http only for localhost): $s" }
                    require(!s.endsWith("/") && !s.endsWith("/api")) { "no trailing slash or /api: $s" }
                    u
                }
            val answers = parse<Path>("PCS_ANSWERS", null) { Path.of(it) }
            val zone =
                parse("PCS_TZ", ZoneId.of("America/New_York")) { s ->
                    try {
                        ZoneId.of(s)
                    } catch (e: java.time.DateTimeException) {
                        throw IllegalArgumentException("unknown time zone: $s")
                    }
                } ?: ZoneId.of("America/New_York")

            fun instant(key: String, s: String): Instant? =
                try {
                    LocalDateTime.parse(s).atZone(zone).toInstant()
                } catch (e: DateTimeParseException) {
                    errors += "$key: not an ISO date-time: $s"
                    null
                }
            val phases = m.filterKeys { it.startsWith("PCS_PHASE_") }.mapNotNull { (k, v) -> instant(k, v)?.let { k.removePrefix("PCS_PHASE_") to it } }.toMap()
            for (k in phases.keys) if (k !in Phases.KEYS) errors += "PCS_PHASE_$k: unknown phase date (spec §10.1)"
            Phases(phases).windowProblems().forEach { errors += it }
            val now = m["PCS_NOW"]?.let { instant("PCS_NOW", it) }
            val acRole =
                parse("PCS_AC_ROLE", "meta") { s ->
                    require(s in setOf("meta", "lead", "manager") || s.startsWith("tag:") && s.length > 4) { "one of meta, lead, manager, tag:<t>: $s" }
                    s
                } ?: "meta"
            val tierTags =
                parse("PCS_TIER_TAGS", emptyMap<String, String>()) { s ->
                    s.split(",").filter { it.isNotBlank() }.associate { kv ->
                        val parts = kv.split("=")
                        require(parts.size == 2 && parts.all { it.isNotBlank() }) { "expected tier=tag pairs: $kv" }
                        parts[0].trim() to parts[1].trim()
                    }
                } ?: emptyMap()
            val scoreScale = parse("PCS_SCORE_MAP", ScoreScale.HOTCRP_DEFAULT) { ScoreScale.parse(it) } ?: ScoreScale.HOTCRP_DEFAULT
            val loadMax =
                m.filterKeys { Regex("PCS_LOAD_[A-Z]+_MAX").matches(it) }
                    .mapKeys { it.key.removePrefix("PCS_LOAD_").removeSuffix("_MAX").lowercase() }
                    .mapValues { (k, _) -> int("PCS_LOAD_${k.uppercase()}_MAX", 0, min = 1) }
            val importFreshDays =
                m.filterKeys { Regex("PCS_IMPORT_FRESH_[A-Z_]+_DAYS").matches(it) }.mapNotNull { (k, _) ->
                    val kind = ImportKind.entries.firstOrNull { it.freshnessKey == k }
                    if (kind == null) {
                        errors += "$k: no such import kind (${ImportKind.entries.joinToString { it.freshnessKey }})"
                        null
                    } else {
                        kind to int(k, kind.defaultFreshDays, min = 1)
                    }
                }.toMap()
            for (k in listOf("PCS_HOTCRP_TOKEN", "PCS_DB_KEY")) {
                if (k in env &&
                    url != null &&
                    !isLocalhost(url)
                ) {
                    errors += "$k: secrets come from the OS keychain; the environment is read only for a localhost HotCRP"
                }
                if (k in conf) errors += "$k: secrets never go in the conference file"
            }
            val s =
                Settings(
                    hotcrpUrl = url ?: URI("http://invalid"),
                    answersPath = answers ?: Path.of(""),
                    zone = zone,
                    phases = phases,
                    now = now,
                    acRole = acRole,
                    tierTags = tierTags,
                    fieldMerit = m["PCS_FIELD_MERIT"] ?: "OveMer",
                    fieldExpertise = m["PCS_FIELD_EXPERTISE"] ?: "RevExp",
                    meritAcceptMin = int("PCS_MERIT_ACCEPT_MIN", 3),
                    expertiseOkMin = int("PCS_EXPERTISE_OK_MIN", 3),
                    reviewsRequired = int("PCS_REVIEWS_REQUIRED", 3, min = 1),
                    earlyRejectWindowH = int("PCS_EARLYREJECT_WINDOW_H", 48, min = 1),
                    scoreScale = scoreScale,
                    dbPath = m["PCS_DB_PATH"]?.let { Path.of(it) },
                    syncIntervalMin = int("PCS_SYNC_INTERVAL_MIN", 15, min = 1),
                    syncChunk = int("PCS_SYNC_CHUNK", 200, min = 1),
                    syncConcurrency = int("PCS_SYNC_CONCURRENCY", 2, min = 1),
                    historyRps = int("PCS_HISTORY_RPS", 1, min = 1),
                    forceShow = bool("PCS_FORCE_SHOW", true),
                    loadMax = mapOf("senior" to 15, "junior" to 8) + loadMax,
                    importFreshDays = importFreshDays,
                    raw = m,
                    venue =
                        Venue(
                            nomineesMax = int("PCS_NOMINEES_MAX", Venue.DEFAULT_NOMINEES_MAX, min = 1),
                            patternMin = int("PCS_PATTERN_MIN", Venue.DEFAULT_PATTERN_MIN, min = 1),
                            accGraceH = int("PCS_ACC_GRACE_H", Venue.DEFAULT_GRACE_H.toInt(), min = 0).toLong(),
                        ),
                    tagChairAttention =
                        (m["PCS_TAG_CHAIR_ATTENTION"] ?: "chair-attention").also {
                            if (!Regex("[A-Za-z0-9_.-]+").matches(it)) errors += "PCS_TAG_CHAIR_ATTENTION: not a HotCRP tag name: $it"
                        },
                )
            return if (errors.isEmpty()) Result.success(s) else Result.failure(SettingsException(errors))
        }
    }
}

/** Every problem at once, so a chair fixes the file in one pass. */
public class SettingsException(public val problems: List<String>) :
    IllegalArgumentException("invalid settings:\n" + problems.joinToString("\n") { "  - $it" })
