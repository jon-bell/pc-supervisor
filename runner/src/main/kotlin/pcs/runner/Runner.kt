package pcs.runner

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import pcs.core.rules.Faults
import pcs.runner.model.ModelActions
import java.net.URI
import java.nio.file.Files
import java.nio.file.Path
import java.security.MessageDigest
import java.time.Instant

/** One step of an exported trace: who acts, the action, and what the model expects. */
data class StepSpec(
    val role: String?,
    val subsystem: String,
    val key: String,
    val args: Map<String, JsonElement>,
    val label: String,
    val effective: Boolean,
    val expect: JsonObject,
)

/** A witness trace exported by the Lean model (`model/export/traces-desk.json`). */
data class TraceSpec(
    val id: String,
    val subsystem: String,
    val family: String,
    val claims: List<String>,
    val reading: JsonObject,
    val steps: List<StepSpec>,
    val verdict: JsonObject,
    val raw: JsonObject,
) {
    companion object {
        fun load(file: Path): List<TraceSpec> =
            Json.parseToJsonElement(Files.readString(file)).jsonArray.map { e ->
                val o = e.jsonObject
                val sub = o["subsystem"]!!.jsonPrimitive.content
                TraceSpec(
                    id = o["id"]!!.jsonPrimitive.content,
                    subsystem = sub,
                    family = o["family"]!!.jsonPrimitive.content,
                    claims = o["claims"]!!.jsonArray.map { it.jsonPrimitive.content },
                    reading = o["reading"]!!.jsonObject,
                    steps =
                        o["steps"]!!.jsonArray.map { s ->
                            val so = s.jsonObject
                            val act = so["action"]!!.jsonObject
                            StepSpec(
                                role = so["role"]?.let { if (it is JsonNull) null else it.jsonPrimitive.content },
                                subsystem = sub,
                                key = act["key"]!!.jsonPrimitive.content,
                                args = act["params"]!!.jsonObject,
                                label = so["label"]!!.jsonPrimitive.content,
                                effective = so["effective"]!!.jsonPrimitive.content.toBoolean(),
                                expect = so["expect"]!!.jsonObject,
                            )
                        },
                    verdict = o["verdict"]!!.jsonObject,
                    raw = o,
                )
            }
    }
}

/** The result of running one trace: the evidence record, and whether the runner saw the system agree with the model. */
data class RunResult(val record: JsonObject, val mismatches: List<String>, val skipped: String? = null)

/**
 * The scenario runner (PLAN §A5, §A6): executes exported traces through the bindings against the
 * harness, syncs, reads every observation, and writes an evidence record per trace. The record
 * holds what was done and read, not whether the test passed; `lake exe check-evidence` re-derives that.
 */
class ScenarioRunner(
    private val harness: URI,
    private val token: String,
    private val repo: Path,
    private val composeProject: String,
    private val evidenceDir: Path,
    val canaries: List<Canary>,
    val dbKey: String,
) : AutoCloseable {
    val scratch: Path = Files.createTempDirectory("pcs-runner")
    private val observer = BoundaryObserver(harness, canaries)
    private val api = HotcrpApi(observer.frontUrl, token)
    private val logs = LogCapture(canaries)
    private val files = FileWriteMonitor(listOf(scratch, evidenceDir), canaries)
    private var nextPid = 0L
    private val authors = mutableMapOf<Long, String>()

    init {
        observer.installJvmWide()
        logs.start()
        Files.createDirectories(evidenceDir)
        files.start()
    }

    // ---- the harness's own processes (the way the seeder reaches the instance's batch scripts) ---------------

    private fun dc(vararg args: String, stdin: String? = null): String {
        val cmd = listOf("docker", "compose", "-p", composeProject, "-f", repo.resolve("hotcrp/compose.yaml").toString()) + args
        val p = ProcessBuilder(cmd).redirectErrorStream(true).start()
        if (stdin != null) p.outputStream.use { it.write(stdin.toByteArray()) } else p.outputStream.close()
        val out = p.inputStream.bufferedReader().readText()
        check(p.waitFor() == 0) { "docker compose ${args.take(4).joinToString(" ")} failed:\n$out" }
        return out
    }

    /** The instance's conventions (spec §11), and room to create papers. */
    fun configureHarness() {
        dc("exec", "-T", "hotcrp", "php", "batch/settings.php", "save", "-e", World.settingsJson())
    }

    /** Creates [n] fresh papers, each with its own author and the AC's screening metareview; returns their ids. */
    fun createPapers(n: Int): List<Long> {
        if (nextPid == 0L) nextPid = maxOf(1000L, api.paperIds().maxOrNull() ?: 0L) + 1
        val pids = (0 until n).map { nextPid + it }
        nextPid += n
        pids.forEach { authors[it] = "runner-author-$it@example.org" }
        val papers =
            pids.joinToString(",", "[", "]") {
                """{"pid":$it,"title":"Synthetic scenario paper $it","abstract":"A synthetic abstract.","authors":[{"email":"${authors[it]}"}],""" +
                    """"status":"submitted","submission":{"content_file":"seed.pdf","mimetype":"application/pdf"}}"""
            }
        val tmp = Files.createTempFile(scratch, "papers", ".json")
        Files.writeString(tmp, papers)
        dc("exec", "-T", "hotcrp", "cp", "test/sample50pg.pdf", "/tmp/seed.pdf")
        dc("cp", tmp.toString(), "hotcrp:/tmp/runner-papers.json")
        dc("exec", "-T", "hotcrp", "php", "batch/savepapers.php", "/tmp/runner-papers.json")
        check(api.ok(api.assign(*pids.map { """{"pid":$it,"action":"metareview","user":"${Persons.AC_REFERRING}","round":"screen"}""" }.toTypedArray())))
        // a comment carrying the comment-text canary, so the scan has something to protect
        val commentCanary = canaries.first { it.name == "comment-text" }.value
        api.call("POST", "${pids.first()}/comment", actas = Persons.AC_REFERRING, json = """{"text":"Synthetic note $commentCanary","visibility":"admin"}""")
        return pids
    }

    // ---- running traces --------------------------------------------------------------------------

    fun run(spec: TraceSpec, pid: Long, faults: BindingFaults = BindingFaults(), implFaults: Faults = Faults.NONE, implFaultName: String? = null): RunResult {
        val readings = World.readingsOf(spec.reading)
        val start = Instant.parse("2030-02-26T12:00:00Z")
        val eventsBefore = observer.events.size
        val steps = mutableListOf<JsonObject>()
        val mismatches = mutableListOf<String>()
        World(
            api,
            token,
            scratch,
            dbKey,
            readings,
            faults,
            implFaults,
            ProcessClock(start, faults),
            FileDriver(scratch),
            "Synthetic second opinion. " + canaries.first { it.name == "review-text" }.value,
        ).use { w ->
            w.open(pid, authors.getValue(pid))
            for ((i, st) in spec.steps.withIndex()) {
                val action = ModelActions.parse(st.subsystem, st.key, st.args, st.label)
                val outcome =
                    try {
                        w.perform(action, st.role)
                    } catch (e: UnboundAction) {
                        return RunResult(JsonObject(emptyMap()), emptyList(), skipped = e.message)
                    }
                val observed = w.observe(st.subsystem)
                steps +=
                    buildJsonObject {
                        put("role", st.role?.let { JsonPrimitive(it) } ?: JsonNull)
                        put(
                            "action",
                            buildJsonObject {
                                put("key", st.key)
                                put("params", JsonObject(st.args))
                            },
                        )
                        put("outcome", outcome.key)
                        put("observed", observed)
                    }
                mismatches += compare(i + 1, st, outcome, observed)
            }
        }
        val record =
            buildJsonObject {
                put("kind", "trace")
                put("traceId", spec.id)
                put("subsystem", spec.subsystem)
                put("family", spec.family)
                put("claims", JsonArray(spec.claims.map { JsonPrimitive(it) }))
                put("reading", spec.reading)
                put("modelMutant", JsonNull)
                put("implementationFault", implFaultName?.let { JsonPrimitive(it) } ?: JsonNull)
                put("bindingMutant", faults.name?.let { JsonPrimitive(it) } ?: JsonNull)
                put("provenance", provenance(if (spec.subsystem == "early reject") "early" else "desk"))
                put("steps", JsonArray(steps))
                put("verdict", spec.verdict)
                put("boundary", boundary(eventsBefore))
            }
        return RunResult(record, mismatches)
    }

    /** The runner's own comparison (the checker re-derives it from the model): outcome and every reader's value against the export. */
    private fun compare(n: Int, st: StepSpec, outcome: Outcome, observed: JsonObject): List<String> {
        val bad = mutableListOf<String>()
        if (outcome.key != (if (st.effective) "effective" else "refused")) bad += "step $n (${st.label}): the system ${outcome.key}"
        for ((k, v) in st.expect) {
            for ((reader, got) in observed[k]!!.jsonObject) if (got != v) bad += "step $n: $k read by $reader is $got, the model expects $v"
        }
        return bad
    }

    private fun boundary(eventsBefore: Int): JsonObject {
        val evs = observer.events.drop(eventsBefore)
        val violations =
            observer.violations().map { "${it.kind}: ${it.detail}" } +
                logs.hits().map { "log-canary: $it" } +
                files.written().filter { it.canaries.isNotEmpty() }.map { "file-canary: ${it.path} ${it.canaries}" }
        return buildJsonObject {
            put("events", evs.size)
            put("destinations", JsonArray(evs.map { it.destination }.distinct().map { JsonPrimitive(it) }))
            put("violations", JsonArray(violations.map { JsonPrimitive(it) }))
        }
    }

    private fun sh(vararg cmd: String): String =
        runCatching {
            ProcessBuilder(*cmd).directory(repo.toFile()).redirectErrorStream(true).start().let { p ->
                p.inputStream.bufferedReader().readText().trim().also { p.waitFor() }
            }
        }.getOrDefault("unknown")

    private fun sha(p: Path): String = MessageDigest.getInstance("SHA-256").digest(Files.readAllBytes(p)).joinToString("") { "%02x".format(it) }

    private fun provenance(exportName: String): JsonObject =
        buildJsonObject {
            put("modelCommit", sh("git", "log", "-1", "--format=%H", "--", "model"))
            put("appBuild", sh("git", "rev-parse", "HEAD") + "+core")
            put(
                "hotcrpRef",
                System.getenv("HOTCRP_REF") ?: Regex("""ARG HOTCRP_REF=(\S+)""").find(Files.readString(repo.resolve("hotcrp/Dockerfile")))?.groupValues?.get(1)
                    ?: "unknown",
            )
            put("answersHash", sha(repo.resolve("model/answers/synthetic.txt")))
            put("traceExportHash", sha(repo.resolve("model/export/traces-$exportName.json")))
            put("generatorSeed", JsonNull)
        }

    fun write(name: String, record: JsonObject) {
        val f = evidenceDir.resolve(name)
        Files.createDirectories(f.parent)
        Files.writeString(f, PRETTY.encodeToString(JsonObject.serializer(), record) + "\n")
    }

    /** Violations seen so far across the observer, the log capture and the file monitor. */
    fun allViolations(): List<String> =
        observer.violations().map { "${it.kind}: ${it.detail}" } +
            logs.hits().map { "log-canary: $it" } +
            files.written().filter { it.canaries.isNotEmpty() }.map { "file-canary: ${it.path} ${it.canaries}" }

    override fun close() {
        logs.close()
        observer.close()
        ProxyReset.restore()
    }
}

private val PRETTY = Json { prettyPrint = true }

/** Puts the JVM's default proxy selector back after a run. */
object ProxyReset {
    private val original = java.net.ProxySelector.getDefault()

    fun restore() = java.net.ProxySelector.setDefault(original)
}
