package net.jonbell.pcs.cli

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonPrimitive
import net.jonbell.pcs.core.config.Settings
import net.jonbell.pcs.core.config.SettingsException
import net.jonbell.pcs.core.hotcrp.HotcrpClient
import net.jonbell.pcs.core.nominations.Resolved
import java.nio.file.Files
import java.nio.file.Path
import kotlin.system.exitProcess

/** `pcs`: `core` without a window (spec §4). */
fun main(args: Array<String>) {
    when (args.firstOrNull()) {
        "probe" -> probe()
        "sync" -> sync()
        "wipe" -> wipe()
        "import" -> importCmd(args.drop(1))
        "export" -> exportCmd(args.drop(1))
        "nominations" -> nominationsCmd()
        "assign" -> assignCmd(args.drop(1))
        "agent" -> agent(args.drop(1))
        "eval" -> exitProcess(net.jonbell.pcs.cli.eval.EvalCommand(System.getenv()).run(args.drop(1)))
        else -> {
            System.err.println(
                "usage: pcs probe | sync | wipe | import <kind> <file> [--map col=name,...] | import status | export tpms <dir> | nominations | assign [--csv <file>] | agent check|probe|plan|run | eval (--export <dir> | --token-file <file>) [...]",
            )
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
    net.jonbell.pcs.core.store.Store.open(path, key).use { store ->
        HotcrpClient(settings.hotcrpUrl, token, chunk = settings.syncChunk, concurrency = settings.syncConcurrency, strict = false).use { c ->
            val counts = runBlocking { net.jonbell.pcs.core.store.Sync(store, net.jonbell.pcs.core.time.Clock.fromSettings(settings.now)).run(c) }
            println("synced into $path: new ${counts.newRows}, changed ${counts.changed}, gone ${counts.gone}")
            if (c.drift.isNotEmpty()) println("contract drift recorded in sync_run: ${c.drift.size} problems")
        }
    }
}

private fun offlineStore(): Triple<Settings, net.jonbell.pcs.core.store.Store, net.jonbell.pcs.core.time.Clock> {
    val env = System.getenv()
    val conf = env["PCS_CONF"]?.let { Path.of(it) }?.takeIf(Files::exists)?.let(Settings::readConf).orEmpty()
    val settings =
        try {
            Settings.load(env + mapOf("PCS_ANSWERS" to (env["PCS_ANSWERS"] ?: "unused")), conf).getOrThrow()
        } catch (e: SettingsException) {
            System.err.println(e.message)
            exitProcess(1)
        }
    val key =
        env["PCS_DB_KEY"]?.takeIf { settings.isLocalHarness }
            ?: error("the DB key comes from the OS keychain (M4); PCS_DB_KEY only for the local harness")
    val path = dbPath(settings)
    Files.createDirectories(path.parent)
    return Triple(settings, net.jonbell.pcs.core.store.Store.open(path, key), net.jonbell.pcs.core.time.Clock.fromSettings(settings.now))
}

/** `pcs import bundle <file> --key-file <key>` (spec §10.3): opens an encrypted screening bundle and imports its findings. The key is read, used, and never stored. */
fun importBundle(
    args: List<String>,
    store: net.jonbell.pcs.core.store.Store,
    imports: net.jonbell.pcs.core.imports.Imports,
    clock: net.jonbell.pcs.core.time.Clock,
) {
    val file = args.firstOrNull()?.takeIf { !it.startsWith("--") }
    val keyFile = args.indexOf("--key-file").takeIf { it >= 0 }?.let { args.getOrNull(it + 1) }
    if (file == null || keyFile == null) {
        System.err.println("usage: pcs import bundle <file> --key-file <file holding the key>")
        exitProcess(2)
    }
    try {
        val key = net.jonbell.pcs.core.bundle.BundleKey.parse(Files.readString(Path.of(keyFile)))
        when (
            val r =
                net.jonbell.pcs.core.bundle.ScreeningBundles(
                    store,
                    imports,
                    clock,
                ).import(Files.readAllBytes(Path.of(file)), key, Path.of(file).fileName.toString())
        ) {
            is net.jonbell.pcs.core.bundle.BundleImport.Imported -> {
                val p = r.payload
                println(
                    "imported bundle ${r.hash.take(
                        12,
                    )}: ${p.findings.size} findings (${p.visible.size} verified), ${p.summaries.size} summaries, ${p.manifest.papers.size} papers, version ${r.run.id}",
                )
                println("manifest: ${p.manifest.checks.size} checks, ${p.manifest.qualifications.size} qualification records, created ${p.manifest.createdAt}")
            }
            is net.jonbell.pcs.core.bundle.BundleImport.AlreadyImported ->
                println(
                    "bundle ${r.hash.take(12)} was already imported (version ${r.runId}); nothing changed",
                )
            is net.jonbell.pcs.core.bundle.BundleImport.Rejected -> {
                System.err.println("nothing imported: ${r.problems.size} problems")
                r.problems.take(20).forEach { System.err.println("  $it") }
                exitProcess(1)
            }
        }
    } catch (e: net.jonbell.pcs.core.bundle.BundleException) {
        System.err.println("nothing imported: ${e.message}")
        exitProcess(1)
    }
}

/**
 * PLAN M6, spec §10.3: `pcs import <kind> <file> [--map col=name,...]` imports a file as a new
 * version (all rows or none; a rejected file prints its row errors and exits 1), and
 * `pcs import status` lists each kind's freshness and the current phase.
 */

fun importCmd(args: List<String>) {
    val kinds = net.jonbell.pcs.core.imports.ImportKind.entries.joinToString("|") { it.id }
    val (settings, store, clock) = offlineStore()
    store.use {
        val imports = net.jonbell.pcs.core.imports.Imports(store, clock)
        if (args.firstOrNull() == "status") {
            println("phase: ${settings.phaseModel.current(clock.now())} at ${clock.now()}")
            imports.staleness(settings.importFreshDays).forEach { println(it.describe()) }
            return
        }
        if (args.firstOrNull() == "bundle") {
            importBundle(args.drop(1), store, imports, clock)
            return
        }
        val kind = args.getOrNull(0)?.let(net.jonbell.pcs.core.imports.ImportKind::ofId)
        if (kind == null || args.size < 2) {
            System.err.println("usage: pcs import ($kinds) <file> [--map col=name,...] | pcs import status")
            exitProcess(2)
        }
        var mapping = emptyMap<String, String>()
        var i = 2
        while (i < args.size) {
            if (args[i] == "--map") {
                mapping =
                    args.getOrNull(++i).orEmpty().split(",").filter { it.isNotBlank() }.associate {
                        it.substringBefore("=").trim() to it.substringAfter("=", "").trim()
                    }
            } else {
                System.err.println("unknown option ${args[i]}")
                exitProcess(2)
            }
            i++
        }
        val file = Path.of(args[1])
        when (val r = imports.import(kind, Files.readAllBytes(file), file.fileName.toString(), mapping)) {
            is net.jonbell.pcs.core.imports.ImportResult.Accepted -> {
                val run = r.run
                println("imported ${run.rows} ${kind.id} rows as version ${run.id} (sha256 ${run.fileHash.take(12)}, at ${run.at})")
                kind.assumption?.let { println("rests on assumption ${it.label}: ${it.text}") }
                val prev = imports.before(run)
                if (prev != null) {
                    val d = imports.diff(prev, imports.snapshotOf(run)!!)
                    println("since version ${prev.run.id}: ${d.added.size} added, ${d.removed.size} removed, ${d.changed.size} changed")
                }
            }
            is net.jonbell.pcs.core.imports.ImportResult.Rejected -> {
                System.err.println("nothing imported: ${r.errors.size} problems in ${file.fileName}")
                r.errors.take(50).forEach { System.err.println("  line ${it.line}${it.column?.let { c -> " [$c]" } ?: ""}: ${it.message}") }
                if (r.errors.size > 50) System.err.println("  ... and ${r.errors.size - 50} more")
                exitProcess(1)
            }
        }
    }
}

/**
 * `pcs nominations` (spec §10.4 A): per-paper nominee checks, what each person owes, patterns, the submission
 * cap, and the membership drafts the latest appointments sheet would produce, under the answers file. A result
 * that turns on an open question prints what each reading would give.
 */
fun nominationsCmd() {
    val (settings, store, clock) = offlineStore()
    store.use {
        val data = net.jonbell.pcs.core.nominations.NominationData(store, net.jonbell.pcs.core.imports.Imports(store, clock))
        val answers = net.jonbell.pcs.core.readings.Answers.read(settings.answersPath)
        val input = data.input()
        val r = net.jonbell.pcs.core.nominations.NominationRules.build(input, answers.readings, venue = settings.venue)

        fun <T> show(x: Resolved<T>, f: (T) -> String): String =
            when (x) {
                is Resolved.Decided -> f(x.value)
                is Resolved.Open ->
                    "open on ${x.by.joinToString { it.code }}: " +
                        x.cases.joinToString("; ") { (m, v) -> m.entries.joinToString(",") { "${it.key.code}=${it.value}" } + " -> " + f(v) }
            }
        println("# nominations: ${input.papers.size} papers, ${input.sheet.size} sheet rows")
        println("## papers that are not compliant")
        r.noncompliant.forEach { p ->
            println(
                "#${p.pid}: ${show(p.compliance) { it.key }}; referable on nomination-noncompliance: ${p.referable?.let { x ->
                    show(x) { b -> b.toString() }
                }}",
            )
        }
        println("## what people owe (reviews)")
        r.obligations.filter { it.papers.isNotEmpty() }.forEach { o ->
            println(
                "${o.email}: ${show(o.owes) {
                    net.jonbell.pcs.core.nominations.NominationRules.show(it)
                }} over papers ${o.papers}${if (o.provisional) " (provisional: a nominee is pending)" else ""}",
            )
        }
        println("## patterns for the PC chairs (a signal, never a ground)")
        r.patterns.forEach { println("${it.author}: always nominates someone else, a junior, on papers ${it.papers}; ${it.consequence}") }
        println("## authors over the submission cap")
        println(
            show(r.capCases) { cs ->
                if (cs.isEmpty()) "none" else cs.joinToString("; ") { "${it.email}: ${it.papers.size} papers, ${it.over} over (${it.papers})" }
            },
        )
        println("## problems in the sheet")
        r.anomalies.forEach { println("${it.subject}: ${it.message}") }
        val plan = net.jonbell.pcs.core.nominations.Appointments.plan(input, settings.tierTags)
        println("## membership drafts: ${plan.drafts.size} candidates are accepted, classified, consenting and not yet on the PC")
        plan.drafts.forEach { println("${it.email} tags=${it.tags}") }
    }
}

/**
 * `pcs assign [--csv <file>]` (spec §10.4 C, §10.5): solves the assignment plan from the mirror and the latest imports under the answers file, and
 * prints the solve report. `--csv` writes the bulk-assign CSV, which a chair applies through Writeback's dry run (the app's Assignment tab drafts it).
 * Nothing is written to HotCRP.
 */
fun assignCmd(args: List<String>) {
    val csvPath = args.indexOf("--csv").takeIf { it >= 0 }?.let { args.getOrNull(it + 1) }
    if (args.isNotEmpty() && args.first() != "--csv" || args.contains("--csv") && csvPath == null) {
        System.err.println("usage: pcs assign [--csv <file>]")
        exitProcess(2)
    }
    val (settings, store, clock) = offlineStore()
    store.use {
        val answers = net.jonbell.pcs.core.readings.Answers.read(settings.answersPath)
        when (
            val i =
                net.jonbell.pcs.core.assignment.AssignmentData(store, net.jonbell.pcs.core.imports.Imports(store, clock))
                    .build(answers.readings, net.jonbell.pcs.core.assignment.AssignmentSettings.of(settings))
        ) {
            is net.jonbell.pcs.core.assignment.AssignmentInput.Blocked -> {
                System.err.println("the plan is blocked:")
                i.reasons.forEach { System.err.println("  - $it") }
                exitProcess(1)
            }
            is net.jonbell.pcs.core.assignment.AssignmentInput.Ready -> {
                val report = net.jonbell.pcs.core.assignment.Assignment.report(i.build)
                print(report.render())
                if (csvPath != null) {
                    Files.writeString(Path.of(csvPath), report.csv.toCsv())
                    println("wrote ${report.csv.rows.size} rows to $csvPath")
                }
                if (report.audit.isNotEmpty()) exitProcess(3)
            }
        }
    }
}

/** `pcs export tpms <dir>` (spec §10.3): the files a chair sends the TPMS operator. */
fun exportCmd(args: List<String>) {
    if (args.firstOrNull() != "tpms" || args.size != 2) {
        System.err.println("usage: pcs export tpms <dir>")
        exitProcess(2)
    }
    val (settings, store, clock) = offlineStore()
    store.use {
        val r =
            net.jonbell.pcs.core.imports.TpmsExport(
                store,
                net.jonbell.pcs.core.imports.Imports(store, clock),
            ).write(Path.of(args[1]), settings.loadMax, settings.reviewsRequired, clock.now())
        println("wrote ${r.files.joinToString()} to ${r.dir} (${r.pcMembers} PC members, ${r.conflicts} conflicts)")
    }
}

/** Deletes the local store (spec §7). */
fun wipe() {
    val (settings, _) = harnessSettings()
    val path = dbPath(settings)
    if (Files.deleteIfExists(path)) println("deleted $path") else println("nothing at $path")
}

/**
 * `pcs agent check <pdf> [--authors authors.json] [--ocr [image]] [--grobid url]`: runs the
 * deterministic checks (agent.md §3.2) on one PDF and prints the findings as JSON. Nothing is
 * sent anywhere: GROBID must be a local URL, OCR runs in a local container with no network, and
 * no reference resolver is configured, so `refs.doi` reports "unverified" for what it cannot look up.
 */
fun agent(args: List<String>) {
    val cli = net.jonbell.pcs.agent.engines.AgentCli(System.getenv())
    when (args.firstOrNull()) {
        "probe" -> exitProcess(cli.probe(args.getOrNull(1)))
        "plan" -> exitProcess(cli.plan(args.drop(1)))
        "run" -> exitProcess(cli.run(args.drop(1)))
        "manifest" -> exitProcess(cli.manifest(args.drop(1)))
        "screen" -> exitProcess(cli.screen(args.drop(1)))
        "shootout" -> exitProcess(cli.shootout(args.drop(1)))
        "corpus" -> exitProcess(cli.corpus(args.drop(1)))
        "bundle" -> exitProcess(cli.bundle(args.drop(1)))
        "qualify" -> exitProcess(cli.qualify(args.drop(1)))
    }
    if (args.firstOrNull() != "check" || args.size < 2) {
        System.err.println(
            "usage: pcs agent check <pdf> [--authors authors.json] [--ocr [image]] [--grobid url] | probe [engine] | plan <pdf>... [--llm-check dir]... | run <pdf>... [--llm-check dir]... | manifest [--decisions file] | screen <pdf>... [--cfp file] | shootout --corpus held-out|recorded (--offline | --engines ids) | corpus validate|pin|standins | qualify --engines ids | bundle <pdf|dir>... --out dir --key-file f | plan --changes [--moves]",
        )
        exitProcess(2)
    }
    val pdf = Path.of(args[1])
    var config = net.jonbell.pcs.agent.checks.ScreenConfig()
    var parser: net.jonbell.pcs.agent.extract.ReferenceParser = net.jonbell.pcs.agent.extract.HeuristicReferenceParser
    var i = 2
    while (i < args.size) {
        when (args[i]) {
            "--authors" -> {
                val text = Files.readString(Path.of(args[++i]))
                config = config.copy(authors = kotlinx.serialization.json.Json.decodeFromString(net.jonbell.pcs.agent.checks.AuthorInfo.serializer(), text))
            }
            "--ocr" -> {
                val image = args.getOrNull(i + 1)?.takeIf { !it.startsWith("--") }?.also { i++ } ?: "pcs-ocr:latest"
                config = config.copy(ocr = net.jonbell.pcs.agent.extract.DockerOcr(image))
            }
            "--grobid" ->
                parser =
                    net.jonbell.pcs.agent.extract.GrobidReferenceParser(net.jonbell.pcs.agent.extract.GrobidReferenceParser.http(args[++i])).let { g ->
                        net.jonbell.pcs.agent.extract.ReferenceParser { x, b -> g.parse(x, b) }
                    }
            else -> {
                System.err.println("unknown option ${args[i]}")
                exitProcess(2)
            }
        }
        i++
    }
    println(net.jonbell.pcs.agent.checks.Screening.run(Files.readAllBytes(pdf), config, parser).toJson())
}
