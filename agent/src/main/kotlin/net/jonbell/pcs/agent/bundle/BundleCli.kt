package net.jonbell.pcs.agent.bundle

import kotlinx.coroutines.runBlocking
import net.jonbell.pcs.agent.checks.AuthorInfo
import net.jonbell.pcs.agent.checks.ScreenConfig
import net.jonbell.pcs.agent.engines.ClearanceRefused
import net.jonbell.pcs.agent.engines.DataClass
import net.jonbell.pcs.agent.engines.Dispatcher
import net.jonbell.pcs.agent.engines.EgressPolicy
import net.jonbell.pcs.agent.engines.EncryptedFileResultStore
import net.jonbell.pcs.agent.engines.EngineConfigException
import net.jonbell.pcs.agent.engines.EngineConfigs
import net.jonbell.pcs.agent.engines.EngineFactory
import net.jonbell.pcs.agent.engines.FileResultStore
import net.jonbell.pcs.agent.engines.InMemoryResultStore
import net.jonbell.pcs.agent.engines.PaperInput
import net.jonbell.pcs.agent.engines.RequestRejected
import net.jonbell.pcs.agent.engines.ResultStore
import net.jonbell.pcs.agent.llm.AbstractSource
import net.jonbell.pcs.agent.llm.CfpSource
import net.jonbell.pcs.agent.llm.CheckEnv
import net.jonbell.pcs.agent.llm.Decisions
import net.jonbell.pcs.agent.llm.Manifest
import net.jonbell.pcs.agent.llm.ScreenOptions
import net.jonbell.pcs.agent.llm.Screener
import net.jonbell.pcs.agent.qualify.QualificationFile
import net.jonbell.pcs.agent.qualify.QualificationGate
import net.jonbell.pcs.agent.qualify.Unqualified
import net.jonbell.pcs.core.bundle.BundleCodec
import net.jonbell.pcs.core.bundle.BundleKey
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.attribute.PosixFilePermissions
import java.time.Instant
import java.time.temporal.ChronoUnit

/**
 * `pcs agent bundle <pdf|dir>... --out <dir> [--key-file f] [--class synthetic|public|confidential] [--cfp f] [--abstracts f]
 * [--abstracts-by-paper f] [--authors f] [--no-effect] [--at ISO]` (agent.md §8): screens the papers (the deterministic checks, then each LLM check routed in the
 * environment) and writes the encrypted, content-addressed bundle `bundle-<sha256>.pcsb` that the chairs' apps import.
 * A paper's id is its file name without the extension (the HotCRP paper id).
 *
 * The key is read from `--key-file` or, if that file does not exist, generated and written there (owner-only). It is never
 * printed, and travels to the other chairs separately from the file. The clearance check is in front of every engine, and for
 * `confidential` papers the qualification gate and the encrypted store are required too.
 */
class BundleCli(private val env: Map<String, String>, private val out: Appendable = System.out) {
    fun bundle(args: List<String>): Int {
        val inputs = mutableListOf<String>()
        var outDir: String? = null
        var keyFile: String? = null
        var dc = DataClass.SYNTHETIC
        var cfp: String? = null
        var abstracts: String? = null
        var abstractsByPaper: String? = null
        var authors: String? = null
        var effect = true
        var at: String? = env["PCS_NOW"]
        var i = 0
        while (i < args.size) {
            when (args[i]) {
                "--out" -> outDir = args[++i]
                "--key-file" -> keyFile = args[++i]
                "--class" -> args[++i].let { v -> dc = DataClass.entries.first { it.name.equals(v, ignoreCase = true) } }
                "--cfp" -> cfp = args[++i]
                "--abstracts" -> abstracts = args[++i]
                "--abstracts-by-paper" -> abstractsByPaper = args[++i]
                "--authors" -> authors = args[++i]
                "--no-effect" -> effect = false
                "--at" -> at = args[++i]
                else -> inputs += args[i]
            }
            i++
        }
        if (inputs.isEmpty() || outDir == null || keyFile == null) {
            out.appendLine(
                "usage: pcs agent bundle <pdf|dir>... --out <dir> --key-file <file> [--class synthetic|public|confidential] [--cfp file] [--no-effect]",
            )
            return 2
        }
        val pdfs =
            inputs.flatMap { p ->
                Path.of(p).let {
                    if (Files.isDirectory(it)) {
                        Files.list(it).use { s ->
                            s.filter { f -> f.toString().endsWith(".pdf") }.sorted().toList()
                        }
                    } else {
                        listOf(it)
                    }
                }
            }
        return try {
            val cs = EngineConfigs.parse(env)
            val registered = cs.map { EngineFactory.create(it, env) }
            EgressPolicy.assertDisjoint(cs.mapNotNull { it.egressHost() }, EgressPolicy.forResolver(env["PCS_AGENT_EGRESS"]))
            val qualPath = env["PCS_AGENT_QUALIFICATIONS"]?.let { Path.of(it) }
            val quals = QualificationFile.load(qualPath)
            val store = store(dc)
            val dispatcher = Dispatcher(registered, store, gate = QualificationGate(quals))
            val routing = EngineConfigs.routing(env)
            val cfpState = CfpSource.resolve(env, cfp)
            CfpSource.warning(routing, cfpState)?.let { out.appendLine(it) }
            // A missing CFP file reopens scope.cfp, so the bundle's manifest lists the scope check as unresolved.
            val decisions = CfpSource.overlay(env["PCS_AGENT_DECISIONS"]?.let { Decisions.load(Path.of(it)) } ?: Decisions.EMPTY, cfpState)
            val checksDir = Path.of(env["PCS_AGENT_CHECKS"] ?: "agent/checks")
            val all = Screener.checks(checksDir)
            val routed = all.filter { it.id in routing }
            val json = kotlinx.serialization.json.Json
            val flat = abstracts?.let { f -> json.decodeFromString<Map<String, String>>(Files.readString(Path.of(f))) }.orEmpty()
            val perPaper = abstractsByPaper?.let { f -> json.decodeFromString<Map<String, Map<String, String>>>(Files.readString(Path.of(f))) }.orEmpty()
            // Author names, affiliations and emails come from a file a chair exports from the mirror: the agent holds no HotCRP credential.
            val authorInfo =
                authors?.let { f ->
                    json.decodeFromString(
                        kotlinx.serialization.builtins.MapSerializer(kotlinx.serialization.serializer<String>(), AuthorInfo.serializer()),
                        Files.readString(Path.of(f)),
                    )
                }.orEmpty()
            val deps = Screener.deterministicDeps(checksDir)
            val cfpText = cfpState.textOrNull
            val papers =
                pdfs.map { f ->
                    val id = f.fileName.toString().removeSuffix(".pdf")
                    PaperInput(id, dc, Files.readAllBytes(f), authorInfo[id]?.let { ScreenConfig(authors = it) } ?: ScreenConfig())
                }
            val screens =
                runBlocking {
                    papers.map { p ->
                        val abs =
                            AbstractSource.fixed(flat + perPaper[p.id].orEmpty()).takeIf { flat.isNotEmpty() || perPaper[p.id] != null } ?: AbstractSource.NONE
                        Screener(dispatcher, routing, routed, decisions, CheckEnv(cfpText, abs), deps, options = ScreenOptions(effect = effect)).screen(p)
                    }
                }
            val rows = Manifest.rows(checksDir, decisions, quals)
            val payload = BundleBuilder.build(papers, screens, rows, quals, (at ?: Instant.now().truncatedTo(ChronoUnit.SECONDS).toString()))
            val key = readOrCreateKey(Path.of(keyFile))
            val file = BundleCodec.encrypt(payload, key)
            val target = Path.of(outDir)
            Files.createDirectories(target)
            val dest = target.resolve(BundleCodec.fileName(payload.hash()))
            Files.write(dest, file)
            val unver = payload.findings.count { !it.verified }
            out.appendLine("# bundle ${payload.hash()}")
            out.appendLine(
                "papers ${papers.size}; findings ${payload.findings.size} (${payload.visible.size} verified, $unver unverified and withheld from every person); summaries ${payload.summaries.size}",
            )
            out.appendLine("LLM checks run: ${routed.joinToString { it.id }.ifEmpty { "none (set PCS_CHECK_<id>_ENGINE)" }}")
            out.appendLine("wrote $dest (encrypted; the key is in $keyFile, send it separately from the file)")
            0
        } catch (e: EngineConfigException) {
            out.appendLine("configuration problems:\n  " + e.problems.joinToString("\n  "))
            1
        } catch (e: ClearanceRefused) {
            out.appendLine("refused: ${e.message}")
            1
        } catch (e: Unqualified) {
            out.appendLine("refused: ${e.message}")
            1
        } catch (e: RequestRejected) {
            out.appendLine("refused: ${e.message}")
            1
        }
    }

    private fun store(dc: DataClass): ResultStore {
        val dir = env["PCS_AGENT_STORE"]?.let { Path.of(it) }
        val keyPath = env["PCS_AGENT_STORE_KEY_FILE"]?.let { Path.of(it) }
        return when {
            keyPath != null -> EncryptedFileResultStore(dir ?: Path.of("agent-store"), BundleKey.parse(Files.readString(keyPath)))
            dc == DataClass.CONFIDENTIAL -> throw EngineConfigException(listOf("confidential papers need the encrypted store: set PCS_AGENT_STORE_KEY_FILE"))
            dir != null -> FileResultStore(dir)
            else -> InMemoryResultStore()
        }
    }

    private fun readOrCreateKey(f: Path): BundleKey {
        if (Files.isRegularFile(f)) return BundleKey.parse(Files.readString(f))
        val k = BundleKey.generate()
        f.toAbsolutePath().parent?.let { Files.createDirectories(it) }
        Files.writeString(f, k.text + "\n")
        runCatching { Files.setPosixFilePermissions(f, PosixFilePermissions.fromString("rw-------")) }
        return k
    }
}
