package pcs.core.imports

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.format.DateTimeParseException

/** One problem in an import file. `line` is the CSV line (1 = header); `column` is the file's own column name. */
public data class RowError(val line: Int, val column: String?, val message: String)

/** An assumption (concepts §3.12) an import kind rests on, and who owns it. */
public data class Assumption(val id: String, val text: String, val owner: String) {
    public val label: String get() = "$id (owner: $owner)"
}

/** The assumptions M6 records (PLAN M6 Evidence). Owners are a decision for the chairs; see PLAN M6 notes. */
public object Assumptions {
    public val A3: Assumption = Assumption("A3", "TPMS files are what the operator sent; scores, where provided, mean affinity", "process chairs")
    public val A4: Assumption = Assumption("A4", "the appointments sheet records the ACs' real decisions; PCS reads it, never edits it", "PC chairs")
}

/** One validated row: its key (spec §10.3 "keyed by") and its normalised columns. */
public data class ImportRow(val key: String, val data: Map<String, String>)

/** The import kinds of spec §10.3, with their columns and row rules. */
public enum class ImportKind(
    public val id: String,
    public val required: List<String>,
    public val optional: List<String>,
    public val assumption: Assumption?,
    /** Extra columns are expected (TPMS's assignment layout is unpublished) and ignored. */
    public val ignoresExtraColumns: Boolean = false,
) {
    APPOINTMENTS(
        "appointments",
        listOf("email", "origin", "nominated_by", "area", "ac_email", "decision", "tier", "consent", "on_pc_at"),
        emptyList(),
        Assumptions.A4,
    ),
    TPMS_ASSIGNMENTS("tpms-assignments", listOf("paper", "email"), listOf("round"), Assumptions.A3, ignoresExtraColumns = true),
    TPMS_SCORES("tpms-scores", listOf("paper", "email", "score"), emptyList(), Assumptions.A3),
    TPMS_REGISTRATIONS("tpms-registrations", listOf("email"), listOf("registered", "n_papers", "last_updated"), Assumptions.A3),
    SCREENING_BUNDLE(
        "screening-bundle",
        listOf("pid", "check", "version", "ground", "engine", "status", "bundle_hash"),
        listOf("anchors"),
        null,
    ),
    REFCHECK("refcheck", listOf("pid", "reference", "status"), listOf("detail"), null),
    ;

    public val columns: List<String> get() = required + optional

    /** The environment name of this kind's freshness setting, `PCS_IMPORT_FRESH_<KIND>_DAYS`. */
    public val freshnessKey: String get() = "PCS_IMPORT_FRESH_${id.uppercase().replace('-', '_')}_DAYS"

    /** Days after which an import of this kind is stale, unless the settings say otherwise. */
    public val defaultFreshDays: Int
        get() =
            when (this) {
                APPOINTMENTS -> 7
                TPMS_REGISTRATIONS -> 14
                TPMS_ASSIGNMENTS, TPMS_SCORES -> 30
                SCREENING_BUNDLE -> 3
                REFCHECK -> 7
            }

    public companion object {
        public fun ofId(id: String): ImportKind? = entries.firstOrNull { it.id == id }
    }

    internal fun validate(c: Cells): ImportRow? {
        val d = LinkedHashMap<String, String>()
        when (this) {
            APPOINTMENTS -> {
                d["email"] = c.email("email") ?: ""
                d["origin"] = c.oneOf("origin", "invited", "self-nominated", "nominee") ?: ""
                d["nominated_by"] = c.pids("nominated_by")
                d["area"] = c["area"]
                d["ac_email"] = c.optEmail("ac_email")
                d["decision"] = c.oneOf("decision", "accept", "decline", "pending") ?: ""
                d["tier"] = c.optOneOf("tier", "senior", "junior")
                d["consent"] = c.yesNo("consent", blankOk = true)
                d["on_pc_at"] = c.date("on_pc_at", blankOk = true)
                if (d["decision"] == "accept" && d["tier"].isNullOrEmpty()) c.error("tier", "an accepted candidate needs a tier (senior or junior)")
            }
            TPMS_ASSIGNMENTS -> {
                d["paper"] = c.pid("paper")
                d["email"] = c.email("email") ?: ""
                d["round"] = c["round"]
            }
            TPMS_SCORES -> {
                d["paper"] = c.pid("paper")
                d["email"] = c.email("email") ?: ""
                val raw = c["score"]
                val v = raw.toDoubleOrNull()
                if (v == null || !v.isFinite() || v < 0.0 || v > 1.0) c.error("score", "a score must be a number from 0 to 1, got '$raw'")
                d["score"] = raw
            }
            TPMS_REGISTRATIONS -> {
                d["email"] = c.email("email") ?: ""
                // A plain list of emails means "registered".
                d["registered"] = if (c.has("registered")) c.yesNo("registered", blankOk = false) else "yes"
                val n = c["n_papers"]
                if (n.isNotEmpty() && (n.toIntOrNull()?.let { it >= 0 } != true)) c.error("n_papers", "not a non-negative integer: '$n'")
                d["n_papers"] = n
                d["last_updated"] = c.date("last_updated", blankOk = true)
            }
            SCREENING_BUNDLE -> {
                d["pid"] = c.pid("pid")
                for (col in listOf("check", "version", "engine", "status", "bundle_hash")) d[col] = c.nonBlank(col)
                d["ground"] = c["ground"]
                val a = c["anchors"]
                if (a.isNotEmpty() && runCatching { Json.parseToJsonElement(a) as JsonArray }.isFailure) c.error("anchors", "anchors must be a JSON array")
                d["anchors"] = a
            }
            REFCHECK -> {
                d["pid"] = c.pid("pid")
                d["reference"] = c.nonBlank("reference")
                d["status"] = c.oneOf("status", "verified", "mismatch", "not-found", "unchecked") ?: ""
                d["detail"] = c["detail"]
            }
        }
        if (c.failed) return null
        val key =
            when (this) {
                APPOINTMENTS, TPMS_REGISTRATIONS -> d["email"]!!
                TPMS_ASSIGNMENTS, TPMS_SCORES -> "${d["paper"]}|${d["email"]}"
                SCREENING_BUNDLE -> "${d["pid"]}|${d["check"]}|${d["ground"]}"
                REFCHECK -> "${d["pid"]}|${d["reference"]}"
            }
        return ImportRow(key, d)
    }
}

/** The cells of one record, keyed by canonical column name, collecting errors as it validates. */
internal class Cells(
    private val line: Int,
    private val cells: Map<String, String>,
    private val fileName: (String) -> String,
    private val errors: MutableList<RowError>,
) {
    var failed = false
        private set

    fun has(col: String): Boolean = col in cells

    operator fun get(col: String): String = cells[col].orEmpty()

    fun error(col: String?, msg: String) {
        failed = true
        errors += RowError(line, col?.let(fileName), msg)
    }

    fun nonBlank(col: String): String = this[col].also { if (it.isEmpty()) error(col, "required, but blank") }

    fun email(col: String): String? {
        val v = this[col].lowercase()
        if (!EMAIL.matches(v)) {
            error(col, if (v.isEmpty()) "required, but blank" else "not an email address: '$v'")
            return null
        }
        return v
    }

    fun optEmail(col: String): String = if (this[col].isEmpty()) "" else email(col) ?: ""

    fun pid(col: String): String {
        val v = this[col]
        if (v.toLongOrNull()?.let { it > 0 } != true) error(col, "not a paper number: '$v'")
        return v
    }

    fun pids(col: String): String {
        val parts = this[col].split(';', ',', ' ').filter { it.isNotBlank() }
        val bad = parts.filter { it.toLongOrNull()?.let { n -> n > 0 } != true }
        if (bad.isNotEmpty()) error(col, "not paper numbers: ${bad.joinToString { "'$it'" }}")
        return parts.mapNotNull { it.toLongOrNull() }.distinct().sorted().joinToString(";")
    }

    fun oneOf(col: String, vararg allowed: String): String? {
        val v = this[col].lowercase()
        if (v !in allowed) {
            error(col, "must be one of ${allowed.joinToString("/")}, got '${this[col]}'")
            return null
        }
        return v
    }

    fun optOneOf(col: String, vararg allowed: String): String = if (this[col].isEmpty()) "" else oneOf(col, *allowed) ?: ""

    fun yesNo(col: String, blankOk: Boolean): String =
        when (this[col].lowercase()) {
            "yes", "true", "y", "1" -> "yes"
            "no", "false", "n", "0" -> "no"
            "" -> if (blankOk) "" else "".also { error(col, "required, but blank") }
            else -> "".also { error(col, "must be yes or no, got '${this[col]}'") }
        }

    fun date(col: String, blankOk: Boolean): String {
        val v = this[col]
        if (v.isEmpty()) return "".also { if (!blankOk) error(col, "required, but blank") }
        val ok =
            try {
                LocalDate.parse(v)
                true
            } catch (_: DateTimeParseException) {
                try {
                    LocalDateTime.parse(v)
                    true
                } catch (_: DateTimeParseException) {
                    runCatching { java.time.Instant.parse(v) }.isSuccess
                }
            }
        if (!ok) error(col, "not an ISO date or date-time: '$v'")
        return v
    }

    companion object {
        val EMAIL = Regex("^[^@\\s,;]+@[^@\\s,;]+\\.[^@\\s,;]+$")
    }
}
