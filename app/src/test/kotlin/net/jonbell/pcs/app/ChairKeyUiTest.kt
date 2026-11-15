package net.jonbell.pcs.app

import androidx.compose.ui.test.ExperimentalTestApi
import net.jonbell.pcs.app.testing.AppDriver
import net.jonbell.pcs.app.testing.Fixtures
import net.jonbell.pcs.app.testing.MapKeychain
import net.jonbell.pcs.app.testing.ViewReader
import net.jonbell.pcs.app.testing.runUi
import net.jonbell.pcs.core.bundle.BundleCodec
import net.jonbell.pcs.core.bundle.ChairKeychain
import net.jonbell.pcs.core.bundle.ChairPublicKey
import net.jonbell.pcs.testing.Covers
import net.jonbell.pcs.testing.Family
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Tag
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Files
import java.nio.file.Path

/** The Settings screen's chair-key section: the public key to give to whoever builds a screening bundle, copy and save; the private half stays in the keychain. */
@Tag("ui")
@Family("T12")
@OptIn(ExperimentalTestApi::class)
class ChairKeyUiTest {
    @Test
    @Covers("view:settings")
    fun `the settings screen shows this chair's public key and saves it, and the private half stays in the keychain`(
        @TempDir dir: Path,
    ) {
        Fixtures.conference(dir, "key-conf", "https://conf-a.example.org", answers = Fixtures.completeAnswers)
        val kc = MapKeychain()
        val shell = Shell(mapOf("PCS_CONFERENCES" to dir.toString()), { kc }, screenshotMode = true)
        System.setProperty("pcs.exportDir", dir.resolve("exports").toString())
        try {
            runUi {
                setContent { PcsApp(shell) }
                val driver = AppDriver(this)
                val view = ViewReader(this)
                driver.waitFor(Tags.PICKER)
                driver.openConference("key-conf")
                driver.tab(TabName.Settings)
                driver.waitFor(ChairKeyTags.TEXT)
                val shown = view.text(ChairKeyTags.TEXT)
                val pub = ChairPublicKey.parse(shown)
                assertTrue(view.text(ChairKeyTags.FINGERPRINT).contains(pub.fingerprint))
                // The keypair is in the keychain, under this conference, and is the one shown.
                val me = ChairKeychain.load(kc, "key-conf")!!
                assertEquals(pub, me.publicKey)
                assertFalse(shown.contains(kc.entries.getValue("key-conf/chair-key")), "only the public half is on screen")
                driver.click(ChairKeyTags.SAVE)
                driver.waitFor(ChairKeyTags.STATUS)
                val saved = dir.resolve("exports/key-conf/chair-key.pub")
                assertTrue(Files.isRegularFile(saved), view.text(ChairKeyTags.STATUS))
                assertEquals(shown, Files.readString(saved).trim())
                // A bundle made for the saved key opens with the keychain's identity.
                val file =
                    BundleCodec.encrypt(
                        net.jonbell.pcs.core.bundle.BundlePayload(
                            net.jonbell.pcs.core.bundle.BundleManifest(createdAt = "2030-01-01T00:00:00Z", papers = emptyList(), checks = emptyList()),
                            emptyList(),
                        ),
                        listOf(ChairPublicKey.parse(Files.readString(saved))),
                    )
                BundleCodec.decrypt(file, me)
            }
        } finally {
            System.clearProperty("pcs.exportDir")
        }
    }
}
