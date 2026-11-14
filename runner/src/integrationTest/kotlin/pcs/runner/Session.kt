package pcs.runner

import pcs.core.config.Settings
import java.net.URI
import java.nio.file.Path
import java.security.SecureRandom

/** The harness and one scenario runner for the whole integration JVM (refuses anything but the local harness; `prop:H4`). */
object Session {
    val repo: Path = Path.of(System.getProperty("pcs.repoRoot") ?: error("pcs.repoRoot not set; run through Gradle"))
    val evidence: Path = Path.of(System.getProperty("pcs.evidenceDir") ?: error("pcs.evidenceDir not set"))
    val harness: URI by lazy {
        val u = URI(System.getenv("PCS_HOTCRP_URL") ?: error("PCS_HOTCRP_URL not set: run scripts/hotcrp-up.sh and source .env.test"))
        check(Settings.isLocalhost(u)) { "refusing to run against a non-harness HotCRP: ${u.host}" }
        u
    }
    val token: String by lazy { System.getenv("PCS_HOTCRP_TOKEN") ?: error("PCS_HOTCRP_TOKEN not set") }

    private fun nonce() = ByteArray(6).also { SecureRandom().nextBytes(it) }.joinToString("") { "%02x".format(it) }

    val canaries: List<Canary> by lazy {
        listOf(
            Canary("token", token, allowedOnHarnessWire = true, allowedAuthorizationHeader = true),
            Canary("db-key", "CANARY-DBKEY-${nonce()}", allowedOnHarnessWire = false),
            Canary("review-text", "CANARY-REVIEW-${nonce()}", allowedOnHarnessWire = true),
            Canary("comment-text", "CANARY-COMMENT-${nonce()}", allowedOnHarnessWire = true),
        )
    }

    val runner: ScenarioRunner by lazy {
        ScenarioRunner(
            harness,
            token,
            repo,
            System.getenv("HOTCRP_COMPOSE_PROJECT") ?: "pcs",
            evidence,
            canaries,
            canaries.first { it.name == "db-key" }.value,
        ).also { it.configureHarness() }
    }

    fun traces(): List<TraceSpec> = TraceSpec.load(repo.resolve("model/export/traces-desk.json"))
}
