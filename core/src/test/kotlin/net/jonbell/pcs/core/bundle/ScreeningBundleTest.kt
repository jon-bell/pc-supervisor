package net.jonbell.pcs.core.bundle

import net.jonbell.pcs.core.imports.ImportKind
import net.jonbell.pcs.core.imports.Imports
import net.jonbell.pcs.core.store.Store
import net.jonbell.pcs.core.time.Clock
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Assertions.fail
import org.junit.jupiter.api.Test
import java.nio.file.Files
import java.time.Instant

class ScreeningBundleTest {
    private val quote = "SYNTHETIC-QUOTE: we previously built the Tool 7 system"
    private val unverified = "SYNTHETIC-UNVERIFIED: text the harness could not find"

    private fun payload(createdAt: String = "2026-11-15T12:00:00Z") =
        BundlePayload(
            BundleManifest(
                createdAt = createdAt,
                papers = listOf(BundlePaper("2", "b".repeat(64), "synthetic"), BundlePaper("1", "a".repeat(64), "synthetic")),
                checks = listOf(BundleManifestRow("format", "abc123", "deterministic", "n/a", listOf("format.limits"), "authors")),
                qualifications = listOf(BundleQualification("scope", "v1", "replay", "m", evidence = "held-out")),
                engines = mapOf("local" to "", "replay" to "m"),
            ),
            listOf(
                BundleFinding(
                    "2",
                    "anonymity",
                    "v",
                    "self-reference",
                    "anonymity",
                    "MEDIUM",
                    "verified",
                    "local",
                    "k2",
                    anchors = listOf(BundleAnchor("page", quote, 1, 9, page = 1)),
                ),
                BundleFinding(
                    "1",
                    "refs.doi",
                    "v",
                    "unresolved",
                    "fabricated-reference",
                    "HIGH",
                    "verified",
                    "local",
                    "k1",
                    anchors = listOf(BundleAnchor("page", "ref one", 0, 3, page = 2)),
                ),
                BundleFinding(
                    "1",
                    "refs.doi",
                    "v",
                    "mismatch",
                    "fabricated-reference",
                    "HIGH",
                    "verified",
                    "local",
                    "k3",
                    anchors = listOf(BundleAnchor("page", "ref two", 4, 8, page = 2)),
                ),
                BundleFinding(
                    "2",
                    "scope",
                    "v",
                    "out-of-scope",
                    null,
                    "MEDIUM",
                    "unverified",
                    "replay",
                    "k4",
                    anchors = listOf(BundleAnchor("page", unverified, 1, 2, page = 1)),
                ),
            ),
            listOf(
                BundleSummary(
                    "1",
                    "summary",
                    "v",
                    "replay",
                    "k5",
                    listOf(BundleSummaryItem("claims", "a claim", BundleAnchor("page", "ref one", 0, 3, page = 1))),
                ),
            ),
        )

    private fun store(dir: java.nio.file.Path, name: String) = Store.open(dir.resolve(name), "test-key")

    @Test
    fun `a bundle round-trips, is content addressed, and the order of findings does not change its address`() {
        val k = ChairIdentity.generate()
        val p = payload()
        val file = BundleCodec.encrypt(p, listOf(k.publicKey))
        assertEquals(p.hash(), BundleCodec.headerHash(file))
        assertEquals(p.canonical(), BundleCodec.decrypt(file, k))
        val shuffled = p.copy(findings = p.findings.reversed(), summaries = p.summaries.reversed())
        assertEquals(p.hash(), shuffled.hash())
        assertNotEquals(p.hash(), payload("2026-11-16T12:00:00Z").hash())
        // A fresh content key and fresh ephemeral keys each time: the same content encrypts to different files with one address.
        val again = BundleCodec.encrypt(p, listOf(k.publicKey))
        assertNotEquals(file.toList(), again.toList())
        assertEquals(BundleCodec.headerHash(file), BundleCodec.headerHash(again))
        assertEquals(listOf(k.publicKey.fingerprint), BundleCodec.recipients(file))
    }

    private fun refused(f: ByteArray, who: ChairIdentity, why: BundleException.Reason) {
        try {
            BundleCodec.decrypt(f, who)
            fail("expected a refusal")
        } catch (e: BundleException) {
            assertEquals(why, e.reason)
            assertFalse(e.message!!.contains(who.stored()))
        }
    }

    @Test
    fun `the file holds no quotation in the clear, a chair it was not made for cannot open it, and a changed byte, header or recipient list is refused`() {
        val k = ChairIdentity.generate()
        val other = ChairIdentity.generate()
        val file = BundleCodec.encrypt(payload(), listOf(k.publicKey))
        assertFalse(String(file, Charsets.ISO_8859_1).contains("SYNTHETIC"))

        // Wrong chair: no wrap carries their fingerprint, so there is nothing to try.
        refused(file, other, BundleException.Reason.NOT_A_RECIPIENT)
        // Someone who rewrites the recipient list to name the other chair's fingerprint still cannot open it: the wrap is for another key.
        val text = String(file, Charsets.ISO_8859_1)
        val forged = text.replace(k.publicKey.fingerprint, other.publicKey.fingerprint).toByteArray(Charsets.ISO_8859_1)
        refused(forged, other, BundleException.Reason.WRONG_KEY_OR_TAMPERED)
        // Tampering: the body, the header (associated data of the wrap and of the body), and the wrap list (associated data of the body).
        refused(file.copyOf().also { it[it.size - 3] = (it[it.size - 3] + 1).toByte() }, k, BundleException.Reason.WRONG_KEY_OR_TAMPERED)
        refused(
            file.copyOf().also { it[12] = if (it[12] == '0'.code.toByte()) '1'.code.toByte() else '0'.code.toByte() },
            k,
            BundleException.Reason.WRONG_KEY_OR_TAMPERED,
        )
        val wrapStart = text.indexOf('\n') + 1
        val inWraps = text.indexOf("\"w\":\"", wrapStart) + 6
        refused(
            file.copyOf().also {
                it[inWraps] =
                    if (it[inWraps] ==
                        'A'.code.toByte()
                    ) {
                        'B'.code.toByte()
                    } else {
                        'A'.code.toByte()
                    }
            },
            k,
            BundleException.Reason.WRONG_KEY_OR_TAMPERED,
        )
        refused("not a bundle".toByteArray(), k, BundleException.Reason.NOT_A_BUNDLE)
        // Nothing secret prints, and a public key survives a round trip through its one-line text.
        assertEquals("ChairIdentity(${k.publicKey.fingerprint})", k.toString())
        assertEquals(k.publicKey, ChairPublicKey.parse(k.publicKey.text + "\n"))
        assertEquals(
            listOf(k.publicKey, other.publicKey),
            ChairPublicKey.parseAll("${k.publicKey.text}, f.txt") {
                if (it ==
                    "f.txt"
                ) {
                    "# chair two\n${other.publicKey.text}\n"
                } else {
                    null
                }
            },
        )
        for (bad in listOf("short", ChairPublicKey.PREFIX + "AAAA")) {
            try {
                ChairPublicKey.parse(bad)
                fail("expected a refusal")
            } catch (e: BundleException) {
                assertEquals(BundleException.Reason.BAD_KEY, e.reason)
            }
        }
    }

    @Test
    fun `two chairs both open the one file with their own private keys, and a third does not`() {
        val a = ChairIdentity.generate()
        val b = ChairIdentity.generate()
        val c = ChairIdentity.generate()
        val p = payload()
        val file = BundleCodec.encrypt(p, listOf(a.publicKey, b.publicKey))
        assertEquals(setOf(a.publicKey.fingerprint, b.publicKey.fingerprint), BundleCodec.recipients(file).toSet())
        assertEquals(p.canonical(), BundleCodec.decrypt(file, a))
        assertEquals(p.canonical(), BundleCodec.decrypt(file, b))
        refused(file, c, BundleException.Reason.NOT_A_RECIPIENT)
        // The same key twice is one wrap; no key at all is not a bundle.
        assertEquals(1, BundleCodec.recipients(BundleCodec.encrypt(p, listOf(a.publicKey, a.publicKey))).size)
        assertTrue(runCatching { BundleCodec.encrypt(p, emptyList()) }.isFailure)
    }

    @Test
    fun `a chair's key lives in the keychain, made on first use and the same afterwards, one per conference, with an exportable public half`() {
        val kc =
            object : net.jonbell.pcs.core.secrets.Keychain {
                val m = mutableMapOf<String, String>()
                override val backend = "test"

                override fun read(account: String) = m[account]

                override fun write(account: String, secret: String) {
                    m[account] = secret
                }
            }
        assertEquals(null, ChairKeychain.load(kc, "conf-1"))
        val first = ChairKeychain.loadOrCreate(kc, "conf-1")
        assertEquals(first.publicKey, ChairKeychain.loadOrCreate(kc, "conf-1").publicKey)
        assertEquals(first.publicKey, ChairKeychain.load(kc, "conf-1")!!.publicKey)
        assertNotEquals(first.publicKey, ChairKeychain.loadOrCreate(kc, "conf-2").publicKey)
        assertEquals(setOf("conf-1/chair-key", "conf-2/chair-key"), kc.m.keys)
        // What the keychain gave back opens a bundle made for the exported public key.
        val file = BundleCodec.encrypt(payload(), listOf(ChairPublicKey.parse(first.publicKey.text)))
        assertEquals(payload().canonical(), BundleCodec.decrypt(file, ChairKeychain.load(kc, "conf-1")!!))
    }

    @Test
    fun `two copies of the app import one bundle and hold identical findings, and an unverified quotation reaches neither`() {
        val dir = Files.createTempDirectory("pcs-bundle-test")
        try {
            val k = ChairIdentity.generate()
            val file = BundleCodec.encrypt(payload(), listOf(k.publicKey))
            val seen =
                listOf("copy-a.db", "copy-b.db").mapIndexed { i, name ->
                    val s = store(dir, name)
                    s.use {
                        val clock = Clock { Instant.parse("2026-11-15T1$i:00:00Z") }
                        val imports = Imports(it, clock)
                        val bundles = ScreeningBundles(it, imports, clock)
                        val r = bundles.import(file, k, "bundle.pcsb") as BundleImport.Imported
                        assertEquals(payload().hash(), r.hash)
                        // The same file again changes nothing.
                        assertTrue(bundles.import(file, k, "bundle.pcsb") is BundleImport.AlreadyImported)
                        assertEquals(1, imports.runs(ImportKind.SCREENING_BUNDLE).size)
                        val rows = imports.latest(ImportKind.SCREENING_BUNDLE)!!.rows.map { it.key to it.data }
                        Triple(rows, bundles.latest(), bundles.visibleFor("1"))
                    }
                }
            assertEquals(seen[0], seen[1])
            val (rows, latest, visible1) = seen[0]
            // Three findings of paper 1 and 2 collapse to a key per pid|check|ground; the unverified one has no anchors.
            assertEquals(listOf("1|refs.doi|fabricated-reference", "2|anonymity|anonymity", "2|scope|"), rows.map { it.first })
            assertEquals("", rows.first { it.first == "2|scope|" }.second["anchors"])
            assertEquals("unverified", rows.first { it.first == "2|scope|" }.second["status"])
            assertTrue(
                rows.first { it.first == "1|refs.doi|fabricated-reference" }.second["anchors"]!!.contains("ref one") &&
                    rows.first().second["anchors"]!!.contains("ref two"),
            )
            assertFalse(rows.any { unverified in it.second.values.joinToString() })
            assertEquals(payload().canonical(), latest)
            assertEquals(2, visible1.size)
            assertEquals(listOf("2|anonymity|anonymity"), rows.map { it.first }.filter { it.startsWith("2|anon") })
            // Neither the key nor a quotation is in either database file in the clear.
            for (name in listOf("copy-a.db", "copy-b.db")) {
                val bytes = String(Files.readAllBytes(dir.resolve(name)), Charsets.ISO_8859_1)
                assertFalse(bytes.contains(k.stored()))
                assertFalse(bytes.contains("SYNTHETIC"))
            }
        } finally {
            dir.toFile().deleteRecursively()
        }
    }

    @Test
    fun `a bundle made for another chair imports nothing`() {
        val dir = Files.createTempDirectory("pcs-bundle-test")
        try {
            val file = BundleCodec.encrypt(payload(), listOf(ChairIdentity.generate().publicKey))
            store(dir, "x.db").use {
                val clock = Clock { Instant.parse("2026-11-15T12:00:00Z") }
                val imports = Imports(it, clock)
                try {
                    ScreeningBundles(it, imports, clock).import(file, ChairIdentity.generate(), "bundle.pcsb")
                    fail("expected a refusal")
                } catch (e: BundleException) {
                    assertEquals(BundleException.Reason.NOT_A_RECIPIENT, e.reason)
                }
                assertEquals(0, imports.runs(ImportKind.SCREENING_BUNDLE).size)
            }
        } finally {
            dir.toFile().deleteRecursively()
        }
    }
}
