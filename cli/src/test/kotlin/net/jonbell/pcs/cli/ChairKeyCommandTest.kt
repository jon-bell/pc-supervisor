package net.jonbell.pcs.cli

import net.jonbell.pcs.core.bundle.BundleCodec
import net.jonbell.pcs.core.bundle.ChairKeychain
import net.jonbell.pcs.core.bundle.ChairPublicKey
import net.jonbell.pcs.core.config.Settings
import net.jonbell.pcs.core.secrets.FileKeychain
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Files
import java.nio.file.Path

/** `pcs chair-key`: the chair's public key for `pcs agent bundle --to`, from the keychain; the private half is never printed. */
class ChairKeyCommandTest {
    private fun env(dir: Path, conference: String = "conf-x") =
        mapOf(
            "PCS_HOTCRP_URL" to "http://127.0.0.1:1",
            "PCS_TZ" to "UTC",
            "PCS_CONFERENCE_ID" to conference,
            "PCS_KEYCHAIN_FILE" to dir.resolve("keychain.txt").toString(),
        )

    private fun run(env: Map<String, String>, vararg args: String): Triple<Int, String, String> {
        val out = StringBuilder()
        val err = StringBuilder()
        return Triple(chairKeyRun(env, args.toList(), out, err), out.toString().trim(), err.toString())
    }

    @Test
    fun `it prints a public key, the same one each time, one per conference, and nothing private`(
        @TempDir dir: Path,
    ) {
        val (code, key, note) = run(env(dir))
        assertEquals(0, code, note)
        val pub = ChairPublicKey.parse(key)
        assertEquals(key, run(env(dir)).second, "the keypair is made once, in the keychain")
        assertNotEquals(key, run(env(dir, "conf-y")).second, "one key per conference")
        assertTrue(note.contains(pub.fingerprint))
        val stored = Files.readString(dir.resolve("keychain.txt"))
        assertTrue(stored.contains("conf-x/chair-key") && stored.contains("conf-y/chair-key"))
        // The private half is in the keychain only: not on either stream, and the file is owner-only.
        val priv = stored.lineSequence().first { it.startsWith("conf-x/chair-key") }.substringAfter('\t')
        assertFalse(key.contains(priv) || note.contains(priv))
        assertEquals("rw-------", java.nio.file.attribute.PosixFilePermissions.toString(Files.getPosixFilePermissions(dir.resolve("keychain.txt"))))
        // --out writes the line to a file that `pcs agent bundle --to` accepts, and the keychain's identity opens what is made for it.
        val f = dir.resolve("mine.pub")
        assertEquals(0, run(env(dir), "--out", f.toString()).first)
        val parsed = ChairPublicKey.parseAll(f.toString()) { runCatching { Files.readString(Path.of(it)) }.getOrNull() }
        assertEquals(listOf(pub), parsed)
        val me = ChairKeychain.load(FileKeychain(dir.resolve("keychain.txt")), "conf-x")!!
        assertEquals(pub, me.publicKey)
        assertTrue(BundleCodec.recipients(BundleCodec.encrypt(emptyPayload(), parsed)).contains(me.publicKey.fingerprint))
    }

    @Test
    fun `the keychain file is honoured for a local instance only`(
        @TempDir dir: Path,
    ) {
        val real = env(dir) + ("PCS_HOTCRP_URL" to "https://conf.example.org")
        val settings = Settings.load(real + ("PCS_ANSWERS" to "unused"), emptyMap()).getOrThrow()
        val kc = runCatching { chairKeychain(real, settings).first }
        assertTrue(kc.isFailure || kc.getOrNull() !is FileKeychain, "a real instance's keys stay in the OS keychain")
        assertFalse(Files.exists(dir.resolve("keychain.txt")))
    }

    private fun emptyPayload() =
        net.jonbell.pcs.core.bundle.BundlePayload(
            net.jonbell.pcs.core.bundle.BundleManifest(createdAt = "2030-01-01T00:00:00Z", papers = emptyList(), checks = emptyList()),
            emptyList(),
        )
}
