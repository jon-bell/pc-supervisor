@file:Suppress("ktlint:standard:max-line-length")

package net.jonbell.pcs.agent.bundle

import net.jonbell.pcs.agent.engines.DataClass
import net.jonbell.pcs.agent.engines.EncryptedFileResultStore
import net.jonbell.pcs.agent.engines.StoredResult
import net.jonbell.pcs.agent.engines.CallResult
import net.jonbell.pcs.agent.engines.Status
import net.jonbell.pcs.agent.engines.Keys
import net.jonbell.pcs.agent.llm.Flag
import net.jonbell.pcs.agent.llm.FlagAnchor
import net.jonbell.pcs.agent.llm.FlagStatus
import net.jonbell.pcs.agent.checks.Severity
import net.jonbell.pcs.core.bundle.BundleCodec
import net.jonbell.pcs.core.bundle.BundleImport
import net.jonbell.pcs.core.bundle.BundleKey
import net.jonbell.pcs.core.bundle.BundlePayload
import net.jonbell.pcs.core.bundle.ScreeningBundles
import net.jonbell.pcs.core.imports.ImportKind
import net.jonbell.pcs.core.imports.Imports
import net.jonbell.pcs.core.store.Store
import net.jonbell.pcs.core.time.Clock
import net.jonbell.pcs.testing.Covers
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Files
import java.nio.file.Path
import java.time.Instant

/** `pcs agent bundle` on synthetic papers through a replay engine: no engine call, no network. */
@Covers("check:anonymity", "check:scope", "prop:S5")
class BundleCliTest {
    private fun cli(env: Map<String, String>, args: List<String>): Pair<Int, String> {
        val sb = StringBuilder()
        val code = BundleCli(env, sb).bundle(args)
        return code to sb.toString()
    }

    private fun importInto(dir: Path, name: String, file: ByteArray, key: BundleKey): Triple<List<Pair<String, Map<String, String>>>, BundlePayload?, Store> {
        val store = Store.open(dir.resolve(name), "test-key")
        val clock = Clock { Instant.parse("2026-11-15T12:00:00Z") }
        val imports = Imports(store, clock)
        val bundles = ScreeningBundles(store, imports, clock)
        assertTrue(bundles.import(file, key, "b.pcsb") is BundleImport.Imported)
        return Triple(imports.latest(ImportKind.SCREENING_BUNDLE)!!.rows.map { it.key to it.data }, bundles.latest(), store)
    }

    @Test
    fun `a bundle is written content addressed and encrypted, another copy imports identical findings`(@TempDir tmp: Path) {
        val items = BundleFixtures.items(10)
        val run = BundleFixtures.prepare(tmp, items.mapIndexed { i, it -> "${101 + i}" to it })
        val key = tmp.resolve("keys/bundle.key")
        val out = tmp.resolve("out")
        val (code, text) = cli(BundleFixtures.env(run), BundleFixtures.args(run, out, key, "--at", "2026-11-15T12:00:00Z"))
        assertEquals(0, code, text)
        val file = Files.list(out).use { it.toList() }.single()
        val bytes = Files.readAllBytes(file)
        val hash = BundleCodec.headerHash(bytes)!!
        assertEquals("bundle-$hash.pcsb", file.fileName.toString(), "named by its content address")
        assertTrue(text.contains("# bundle $hash"))
        // The key is in its file, owner-only, and never on the console.
        val keyText = Files.readString(key).trim()
        assertFalse(text.contains(keyText))
        assertEquals("rw-------", java.nio.file.attribute.PosixFilePermissions.toString(Files.getPosixFilePermissions(key)))
        // Nothing of any paper is in the clear.
        val clear = String(bytes, Charsets.ISO_8859_1)
        assertFalse(items.any { it.case.spec.title in clear })

        val k = BundleKey.parse(keyText)
        val a = importInto(tmp, "a.db", bytes, k)
        val b = importInto(tmp, "b.db", bytes, k)
        a.third.close()
        b.third.close()
        assertEquals(a.first, b.first)
        assertEquals(a.second, b.second)
        val payload = a.second!!
        assertEquals(hash, payload.hash())
        // The findings are what screening produced (the recording run names its engine "strong", the replay "rep"; nothing else differs).
        fun norm(f: net.jonbell.pcs.core.bundle.BundleFinding) = f.copy(engine = if (f.engine == "local") "local" else "llm", fields = f.fields.toSortedMap(), dependsOn = f.dependsOn.sorted())
        val direct = run.screens.values.flatten().map { norm(BundleBuilder.finding(it)) }
        assertEquals(direct.size, payload.findings.size)
        assertEquals(direct.toSet(), payload.findings.map(::norm).toSet())
        assertTrue(payload.findings.any { it.engine == "local" } && payload.findings.any { it.engine == "rep" }, "deterministic and replayed LLM findings")
        assertEquals(items.size, payload.manifest.papers.size)
        assertTrue(payload.manifest.checks.any { it.check == "scope" && it.qualifiedOn == "unqualified" })
        assertEquals(setOf("local", "rep"), payload.findings.map { it.engine }.toSet())
    }

    @Test
    fun `the same run again writes the same bundle address, a different key does not open it`(@TempDir tmp: Path) {
        val run = BundleFixtures.prepare(tmp, BundleFixtures.items(4).mapIndexed { i, it -> "${7 + i}" to it })
        val key = tmp.resolve("bundle.key")
        val a = tmp.resolve("a")
        val b = tmp.resolve("b")
        assertEquals(0, cli(BundleFixtures.env(run), BundleFixtures.args(run, a, key, "--at", "2026-11-15T12:00:00Z")).first)
        assertEquals(0, cli(BundleFixtures.env(run), BundleFixtures.args(run, b, key, "--at", "2026-11-15T12:00:00Z")).first)
        assertEquals(Files.list(a).use { it.toList() }.single().fileName, Files.list(b).use { it.toList() }.single().fileName, "equal content, equal address")
        val bytes = Files.readAllBytes(Files.list(a).use { it.toList() }.single())
        assertThrows<net.jonbell.pcs.core.bundle.BundleException> { BundleCodec.decrypt(bytes, BundleKey.generate()) }
        assertNotNull(BundleCodec.decrypt(bytes, BundleKey.parse(Files.readString(key))))
    }

    @Test
    fun `confidential papers are refused without the encrypted store, without clearance, and without qualification, before any paper is screened`(@TempDir tmp: Path) {
        val run = BundleFixtures.prepare(tmp, BundleFixtures.items(3).mapIndexed { i, it -> "${1 + i}" to it })
        val args = BundleFixtures.args(run, tmp.resolve("out"), tmp.resolve("k"), "--class", "confidential")
        val noStore = cli(BundleFixtures.env(run), args)
        assertEquals(1, noStore.first)
        assertTrue(noStore.second.contains("encrypted store"), noStore.second)
        val storeKey = tmp.resolve("store.key").also { Files.writeString(it, BundleKey.generate().text) }
        val withStore = BundleFixtures.env(run, mapOf("PCS_AGENT_STORE_KEY_FILE" to storeKey.toString(), "PCS_AGENT_STORE" to tmp.resolve("store").toString()))
        val low = cli(withStore, args)
        assertEquals(1, low.first)
        assertTrue(low.second.contains("cleared for synthetic data"), low.second)
        val cleared = withStore + mapOf("PCS_ENGINE_rep_CLEARANCE" to "confidential", "PCS_ENGINE_rep_CLEARANCE_DECISION" to "d-engine")
        val noQual = cli(cleared, args)
        assertEquals(1, noQual.first)
        assertTrue(noQual.second.contains("is not qualified for confidential data"), noQual.second)
        assertFalse(Files.exists(tmp.resolve("out")), "no bundle was written")
    }

    @Test
    fun `the encrypted store takes confidential results, keeps them off the disk in the clear, and refuses another key or a moved file`(@TempDir tmp: Path) {
        val key = BundleKey.generate()
        val s = EncryptedFileResultStore(tmp.resolve("st"), key)
        val k1 = Keys.sha256("one")
        val k2 = Keys.sha256("two")
        val r = StoredResult(k1, "scope", "v", "e", "7", DataClass.CONFIDENTIAL, CallResult(k1, Status.OK, kotlinx.serialization.json.JsonPrimitive("CONFIDENTIAL-QUOTE"), raw = "CONFIDENTIAL-RAW"))
        s.put(r)
        assertEquals(r, s.get(k1))
        assertEquals(listOf(r), s.all())
        val file = Files.list(tmp.resolve("st")).use { it.toList() }.single()
        assertFalse(String(Files.readAllBytes(file), Charsets.ISO_8859_1).contains("CONFIDENTIAL"))
        assertThrows<IllegalStateException> { EncryptedFileResultStore(tmp.resolve("st"), BundleKey.generate()).get(k1) }
        Files.copy(file, tmp.resolve("st/$k2.enc"))
        assertThrows<IllegalStateException> { s.get(k2) }
        assertThrows<IllegalArgumentException> { net.jonbell.pcs.agent.engines.FileResultStore(tmp.resolve("plain")).put(r) }
    }

    @Test
    fun `an unverified flag's quotation never enters the bundle`() {
        val f =
            Flag(
                "9", "scope", "v", emptyList(), "out-of-scope", "scope", Severity.MEDIUM,
                listOf(FlagAnchor("page", 1, 5, "QUOTE-NOT-FOUND-ON-THE-PAGE", page = 1)),
                mapOf("reason" to "REASON-TEXT", "measured.pages" to "3"), "rep", "k", FlagStatus.UNVERIFIED, listOf("the quotation is not at its anchor"),
            )
        val b = BundleBuilder.finding(f)
        assertEquals("unverified", b.status)
        assertTrue(b.anchors.isEmpty())
        assertEquals(mapOf("measured.pages" to "3"), b.fields)
        assertFalse(BundleCodec.encrypt(BundlePayload(net.jonbell.pcs.core.bundle.BundleManifest(createdAt = "t", papers = emptyList(), checks = emptyList()), listOf(b)), BundleKey.generate()).let { String(it, Charsets.ISO_8859_1) }.contains("QUOTE-NOT-FOUND"))
    }
}
