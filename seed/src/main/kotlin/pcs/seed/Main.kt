package pcs.seed

import java.net.URI
import java.nio.file.Path
import kotlin.system.exitProcess

val scenarios: Map<String, Scenario> = mapOf("golden" to Golden.scenario)

/** `./gradlew :seed:run --args=golden` with the harness's .env.test in the environment. */
fun main(args: Array<String>) {
    val s =
        scenarios[args.firstOrNull()] ?: run {
            System.err.println("usage: seed <${scenarios.keys.joinToString("|")}>")
            exitProcess(2)
        }
    val url = URI(System.getenv("PCS_HOTCRP_URL") ?: error("PCS_HOTCRP_URL not set (source .env.test)"))
    val token = System.getenv("PCS_HOTCRP_TOKEN") ?: error("PCS_HOTCRP_TOKEN not set")
    val d = Driver(url, token, Path.of("").toAbsolutePath(), System.getenv("HOTCRP_COMPOSE_PROJECT") ?: "pcs")
    val r = d.seed(s)
    println("seeded ${s.name}: ${s.papers.size} papers, ${s.pc.size} PC, ${r.reviewTimes.size} reviews, ${r.commentTimes.size} comments")
}
