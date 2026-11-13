package pcs.core

import pcs.core.config.Settings
import pcs.core.hotcrp.HotcrpClient
import java.net.URI

/**
 * The only way an integration test reaches HotCRP. It refuses to start unless the URL is the
 * local harness (AGENTS.md non-negotiable 2; `prop:H4`).
 */
object Harness {
    val url: URI by lazy {
        val u = URI(System.getenv("PCS_HOTCRP_URL") ?: error("PCS_HOTCRP_URL not set: run scripts/hotcrp-up.sh and source .env.test"))
        check(Settings.isLocalhost(u)) { "refusing to run integration tests against a non-harness HotCRP: ${u.host}" }
        u
    }
    private val token: String by lazy { System.getenv("PCS_HOTCRP_TOKEN") ?: error("PCS_HOTCRP_TOKEN not set") }

    fun client(strict: Boolean = true): HotcrpClient = HotcrpClient(url, token, chunk = 5, strict = strict)
}
