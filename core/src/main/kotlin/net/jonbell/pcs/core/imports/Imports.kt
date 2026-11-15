package net.jonbell.pcs.core.imports

import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import net.jonbell.pcs.core.store.Store
import net.jonbell.pcs.core.time.Clock
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import java.security.MessageDigest
import java.time.Duration
import java.time.Instant

/** One recorded import attempt (spec §3 `import_run`). Only `accepted` runs have rows. */
public data class ImportRun(
    val id: Long,
    val kind: ImportKind,
    val source: String,
    val at: Instant,
    val fileHash: String,
    val rows: Int,
    val accepted: Boolean,
    val errors: List<RowError>,
    val mapping: Map<String, String>,
    val assumption: String?,
)

public sealed interface ImportResult {
    public data class Accepted(val run: ImportRun) : ImportResult

    /** Nothing was imported; the attempt is recorded with these errors. */
    public data class Rejected(val run: ImportRun) : ImportResult {
        val errors: List<RowError> get() = run.errors
    }
}

/** The rows a sheet held in one version. */
public class ImportSnapshot(public val run: ImportRun, public val rows: List<ImportRow>) {
    public val byKey: Map<String, ImportRow> by lazy { rows.associateBy { it.key } }
}

public data class ImportDiff(val added: List<String>, val removed: List<String>, val changed: List<String>) {
    val isEmpty: Boolean get() = added.isEmpty() && removed.isEmpty() && changed.isEmpty()
}

public enum class Freshness { FRESH, STALE, MISSING }

/** `prop:M2`: what a process chair is told about one kind of import. */
public data class ImportStatus(val kind: ImportKind, val state: Freshness, val lastAt: Instant?, val age: Duration?, val freshDays: Int) {
    public fun describe(): String =
        when (state) {
            Freshness.MISSING -> "${kind.id}: never imported"
            Freshness.FRESH -> "${kind.id}: fresh (imported $lastAt, ${age!!.toDays()} d old, limit $freshDays d)"
            Freshness.STALE -> "${kind.id}: STALE (imported $lastAt, ${age!!.toDays()} d old, limit $freshDays d)"
        }
}

/**
 * Versioned imports (spec §10.3). Each import is a new version with a timestamp and a content
 * hash; old versions stay, so "what did the sheet say at time X" is [asOf]. An import takes all
 * rows or none: the whole file is validated first, and a file with any error stores no rows.
 */
public class Imports(private val store: Store, private val clock: Clock) {
    private val json = Json

    public fun import(kind: ImportKind, content: ByteArray, source: String, mapping: Map<String, String> = emptyMap()): ImportResult {
        val at = clock.now()
        val hash = MessageDigest.getInstance("SHA-256").digest(content).joinToString("") { "%02x".format(it) }
        val errors = mutableListOf<RowError>()
        val rows = parse(kind, content, mapping, errors)
        val ok = errors.isEmpty()
        val id =
            store.tx { c ->
                val runId =
                    c.prepareStatement(
                        "INSERT INTO import_run(kind,source,at,file_hash,rows,status,row_errors,mapping,assumption) VALUES(?,?,?,?,?,?,?,?,?)",
                        java.sql.Statement.RETURN_GENERATED_KEYS,
                    ).use { st ->
                        st.setString(1, kind.id)
                        st.setString(2, source)
                        st.setLong(3, at.epochSecond)
                        st.setString(4, hash)
                        st.setInt(5, if (ok) rows.size else 0)
                        st.setString(6, if (ok) "ok" else "rejected")
                        st.setString(7, errorsJson(errors))
                        st.setString(8, json.encodeToString(MapSerializer(String.serializer(), String.serializer()), mapping))
                        st.setString(9, kind.assumption?.label)
                        st.executeUpdate()
                        st.generatedKeys.use {
                            it.next()
                            it.getLong(1)
                        }
                    }
                if (ok) {
                    c.prepareStatement("INSERT INTO import_row(run_id,row_no,key,data) VALUES(?,?,?,?)").use { st ->
                        rows.forEachIndexed { i, r ->
                            st.setLong(1, runId)
                            st.setInt(2, i + 1)
                            st.setString(3, r.key)
                            st.setString(4, json.encodeToString(MapSerializer(String.serializer(), String.serializer()), r.data))
                            st.addBatch()
                        }
                        st.executeBatch()
                    }
                }
                runId
            }
        val run = ImportRun(id, kind, source, at, hash, if (ok) rows.size else 0, ok, errors.toList(), mapping, kind.assumption?.label)
        return if (ok) ImportResult.Accepted(run) else ImportResult.Rejected(run)
    }

    /** Every attempt for a kind, oldest first. */
    public fun runs(kind: ImportKind): List<ImportRun> {
        val out = mutableListOf<ImportRun>()
        store.conn.prepareStatement(
            "SELECT id,kind,source,at,file_hash,rows,status,row_errors,mapping,assumption FROM import_run WHERE kind=? ORDER BY at, id",
        ).use { st ->
            st.setString(1, kind.id)
            st.executeQuery().use { rs ->
                while (rs.next()) out += readRun(rs)
            }
        }
        return out
    }

    /** What the sheet said at [at]: the latest accepted version imported at or before that instant, or null. */
    public fun asOf(kind: ImportKind, at: Instant): ImportSnapshot? =
        snapshot(
            "SELECT id,kind,source,at,file_hash,rows,status,row_errors,mapping,assumption FROM import_run WHERE kind=? AND status='ok' AND at<=? ORDER BY at DESC, id DESC LIMIT 1",
            kind.id,
            at.epochSecond,
        )

    /** The accepted version before [run] (by version id), for diffing consecutive imports. */
    public fun before(run: ImportRun): ImportSnapshot? =
        snapshot(
            "SELECT id,kind,source,at,file_hash,rows,status,row_errors,mapping,assumption FROM import_run WHERE kind=? AND status='ok' AND id<? ORDER BY id DESC LIMIT 1",
            run.kind.id,
            run.id,
        )

    /** The accepted version [run] (an accepted run's rows), or null if it was rejected. */
    public fun snapshotOf(run: ImportRun): ImportSnapshot? =
        if (!run.accepted) {
            null
        } else {
            snapshot(
                "SELECT id,kind,source,at,file_hash,rows,status,row_errors,mapping,assumption FROM import_run WHERE kind=? AND id=?",
                run.kind.id,
                run.id,
            )
        }

    private fun snapshot(sql: String, kindId: String, n: Long): ImportSnapshot? {
        val run =
            store.conn.prepareStatement(sql).use { st ->
                st.setString(1, kindId)
                st.setLong(2, n)
                st.executeQuery().use { rs -> if (rs.next()) readRun(rs) else null }
            } ?: return null
        val rows = mutableListOf<ImportRow>()
        store.conn.prepareStatement("SELECT key,data FROM import_row WHERE run_id=? ORDER BY row_no").use { st ->
            st.setLong(1, run.id)
            st.executeQuery().use { rs ->
                while (rs.next()) {
                    val data = json.parseToJsonElement(rs.getString(2)).jsonObject.mapValues { it.value.jsonPrimitive.content }
                    rows += ImportRow(rs.getString(1), data)
                }
            }
        }
        return ImportSnapshot(run, rows)
    }

    /** The current version, by the clock (`PCS_NOW` pins it). */
    public fun latest(kind: ImportKind): ImportSnapshot? = asOf(kind, clock.now())

    /** `tpms-registrations` and the rest are diffed between versions by key. */
    public fun diff(before: ImportSnapshot?, after: ImportSnapshot): ImportDiff {
        val b = before?.byKey.orEmpty()
        val a = after.byKey
        return ImportDiff(
            added = (a.keys - b.keys).sorted(),
            removed = (b.keys - a.keys).sorted(),
            changed = a.keys.intersect(b.keys).filter { a[it]!!.data != b[it]!!.data }.sorted(),
        )
    }

    /**
     * `prop:M2`: for each kind, whether its latest accepted import is older than its freshness
     * limit. [freshDays] overrides the defaults per kind (`PCS_IMPORT_FRESH_<KIND>_DAYS`).
     */
    public fun staleness(freshDays: Map<ImportKind, Int> = emptyMap()): List<ImportStatus> {
        val now = clock.now()
        return ImportKind.entries.map { k ->
            val limit = freshDays[k] ?: k.defaultFreshDays
            val last = latest(k)?.run?.at
            when {
                last == null -> ImportStatus(k, Freshness.MISSING, null, null, limit)
                else -> {
                    val age = Duration.between(last, now)
                    ImportStatus(k, if (age > Duration.ofDays(limit.toLong())) Freshness.STALE else Freshness.FRESH, last, age, limit)
                }
            }
        }
    }

    private fun readRun(rs: java.sql.ResultSet): ImportRun {
        val errs =
            (json.parseToJsonElement(rs.getString(8)) as JsonArray).map {
                val o = it.jsonObject
                RowError(o["line"]!!.jsonPrimitive.int, o["column"]?.jsonPrimitive?.contentOrNull, o["message"]!!.jsonPrimitive.content)
            }
        val mapping = json.decodeFromString(MapSerializer(String.serializer(), String.serializer()), rs.getString(9))
        return ImportRun(
            rs.getLong(1),
            ImportKind.ofId(rs.getString(2))!!,
            rs.getString(3),
            Instant.ofEpochSecond(rs.getLong(4)),
            rs.getString(5),
            rs.getInt(6),
            rs.getString(7) == "ok",
            errs,
            mapping,
            rs.getString(10),
        )
    }

    private fun errorsJson(errors: List<RowError>): String =
        JsonArray(
            errors.map { e ->
                buildJsonObject {
                    put("line", e.line)
                    put("column", e.column?.let { JsonPrimitive(it) } ?: kotlinx.serialization.json.JsonNull)
                    put("message", e.message)
                }
            },
        ).toString()

    private fun parse(kind: ImportKind, content: ByteArray, mapping: Map<String, String>, errors: MutableList<RowError>): List<ImportRow> {
        val text =
            try {
                Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(content)).toString()
            } catch (_: CharacterCodingException) {
                errors += RowError(1, null, "the file is not valid UTF-8")
                return emptyList()
            }
        for (k in mapping.keys) if (k !in kind.columns) errors += RowError(1, null, "--map: '$k' is not a ${kind.id} column (${kind.columns.joinToString()})")
        val csv =
            Csv.parse(text).getOrElse {
                errors += RowError((it as? CsvError)?.line ?: 1, null, it.message ?: "unreadable CSV")
                return emptyList()
            }
        val header = csv.header.map { it.lowercase() }
        header.groupBy { it }.filter { it.value.size > 1 }.keys.forEach { errors += RowError(1, it, "duplicate column") }
        val fileName = { canon: String -> mapping[canon] ?: canon }
        val index = mutableMapOf<String, Int>()
        for (col in kind.columns) {
            val i = header.indexOf(fileName(col).lowercase())
            if (i >= 0) {
                index[col] = i
            } else if (col in kind.required) {
                errors += RowError(1, fileName(col), "missing required column '${fileName(col)}'")
            }
        }
        if (!kind.ignoresExtraColumns) {
            val known = kind.columns.map { fileName(it).lowercase() }.toSet()
            csv.header.filter { it.lowercase() !in known }.forEach { errors += RowError(1, it, "unknown column") }
        }
        if (errors.isNotEmpty()) return emptyList()
        val rows = mutableListOf<ImportRow>()
        val seen = mutableMapOf<String, Int>()
        for ((line, fields) in csv.records) {
            if (fields.size != header.size) {
                errors += RowError(line, null, "expected ${header.size} fields, found ${fields.size}")
                continue
            }
            val cells = Cells(line, index.mapValues { (_, i) -> fields[i] }, fileName, errors)
            val row = kind.validate(cells) ?: continue
            val first = seen.putIfAbsent(row.key, line)
            if (first != null) {
                errors += RowError(line, null, "duplicate of line $first (key '${row.key}')")
                continue
            }
            rows += row
        }
        errors.sortBy { it.line }
        return rows
    }
}
