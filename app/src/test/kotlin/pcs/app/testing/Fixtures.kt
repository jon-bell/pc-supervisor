package pcs.app.testing

import pcs.app.UrlOpener
import pcs.core.secrets.Keychain
import pcs.testing.LocalHarness
import java.net.URI
import java.nio.file.Files
import java.nio.file.Path

/** An in-memory keychain: the tests never touch the OS's. */
class MapKeychain : Keychain {
    val entries = mutableMapOf<String, String>()
    override val backend = "in-memory test keychain"

    override fun read(account: String) = entries[account]

    override fun write(account: String, secret: String) {
        entries[account] = secret
    }
}

/** Records the URLs the app would open; nothing launches a browser. */
class RecordingOpener : UrlOpener {
    val opened = mutableListOf<String>()

    override fun open(url: String) {
        opened += url
    }
}

/** `PCS_NOW` for every UI test: the golden scenario's primary assertion instant (PLAN, golden scenario). */
const val PINNED_NOW = "2030-02-26T12:00:00"

object Fixtures {
    val repo: Path = Path.of(System.getProperty("pcs.repoRoot"))
    val syntheticAnswers: Path = repo.resolve("model/answers/synthetic.txt")

    /** Every question answered with a reading (`model/answers/complete.txt`): nothing is open, so nothing is blocked. */
    val completeAnswers: Path = repo.resolve("model/answers/complete.txt")

    /** The harness URL and chair token from the environment; refuses anything but localhost (AGENTS.md non-negotiable 2). */
    fun harness(): Pair<URI, String> {
        val url = System.getenv("PCS_HOTCRP_URL") ?: error("PCS_HOTCRP_URL is not set: start the harness and load .env.test (see AGENTS.md)")
        val token = System.getenv("PCS_HOTCRP_TOKEN") ?: error("PCS_HOTCRP_TOKEN is not set")
        return LocalHarness.require(url) to token
    }

    /** Writes `<id>.conf` into [dir]: a conference with its own store file next to it. */
    fun conference(dir: Path, id: String, url: String, answers: Path = syntheticAnswers): Path =
        Files.writeString(
            dir.resolve("$id.conf"),
            "PCS_HOTCRP_URL=$url\nPCS_ANSWERS=$answers\nPCS_DB_PATH=${dir.resolve("$id.db")}\nPCS_NOW=$PINNED_NOW\nPCS_TZ=UTC\n",
        )
}
