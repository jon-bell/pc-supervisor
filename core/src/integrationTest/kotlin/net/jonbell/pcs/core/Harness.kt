package net.jonbell.pcs.core

import net.jonbell.pcs.core.hotcrp.HotcrpClient
import net.jonbell.pcs.testing.LocalHarness
import java.net.URI

/**
 * The only way an integration test reaches HotCRP. It refuses to start unless the URL is the
 * local harness (AGENTS.md non-negotiable 2; `prop:H4`).
 */
object Harness {
    val url: URI by lazy {
        LocalHarness.require(System.getenv("PCS_HOTCRP_URL") ?: error("PCS_HOTCRP_URL not set: run scripts/hotcrp-up.sh and source .env.test"))
    }
    private val token: String by lazy { System.getenv("PCS_HOTCRP_TOKEN") ?: error("PCS_HOTCRP_TOKEN not set") }

    fun client(strict: Boolean = true): HotcrpClient = HotcrpClient(url, token, chunk = 5, strict = strict)
}
