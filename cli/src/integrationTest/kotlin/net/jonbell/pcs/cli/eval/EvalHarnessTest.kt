package net.jonbell.pcs.cli.eval

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import net.jonbell.pcs.core.hotcrp.HotcrpClient
import net.jonbell.pcs.testing.Covers
import net.jonbell.pcs.testing.Family
import net.jonbell.pcs.testing.LocalHarness
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.nio.file.Files

/**
 * PLAN M21 on the seeded conference of the local harness: the kit reads it with a token (read paths only), and the report holds no identifier,
 * title, name or address that the conference holds. The same data as an export directory gives the same report.
 */
@Family("T7")
class EvalHarnessTest {
    private val url = LocalHarness.require(System.getenv("PCS_HOTCRP_URL") ?: error("PCS_HOTCRP_URL not set: run scripts/hotcrp-up.sh and source .env.test"))
    private val token = System.getenv("PCS_HOTCRP_TOKEN") ?: error("PCS_HOTCRP_TOKEN not set")

    private fun eval(args: List<String>): String {
        val out = StringBuilder()
        val err = StringBuilder()
        val gates = mutableListOf<RequestedNetwork>()
        val code = EvalCommand(mapOf("PCS_HOTCRP_URL" to url.toString()), out, err, { RequestedNetwork(it).also(gates::add) }).run(args)
        assertEquals(0, code, "$out$err")
        return out.toString()
    }

    @Test
    @Covers("prop:C1", "prop:S5", "prop:H4", "prop:H5")
    fun `the report on the seeded conference holds nothing from the conference, and the token never appears`() {
        val dir = Files.createTempDirectory("pcs-eval-it")
        try {
            val tokenFile = dir.resolve("token")
            Files.writeString(tokenFile, token)
            val report = eval(listOf("--token-file", tokenFile.toString()))
            val (pc, papers, reviews) =
                HotcrpClient(url, token, chunk = 5, strict = false).use { c ->
                    runBlocking {
                        val pc = c.pc()
                        val pids = c.paperIds()
                        Triple(pc, c.papers(pids), c.reviews(pids))
                    }
                }
            assertTrue(papers.size > 5 && pc.size > 5, "the harness is seeded")
            assertTrue(report.contains("- Network used: hotcrp") && report.contains("a HotCRP token (read-only)"), report)
            val lower = report.lowercase()
            val secrets =
                papers.flatMap { listOfNotNull(it.title) + it.authors } + pc.flatMap { listOfNotNull(it.email, it.name) } +
                    reviews.mapNotNull { it.reviewerEmail } + url.host + token
            for (s in secrets.filter { it.isNotBlank() }) assertFalse(lower.contains(s.lowercase()), "the report contains an input string")
            // The harness's paper ids are small numbers, which are also counts, so a bare number proves nothing: look for an id in every form one is
            // written (#5, paper 5, pid 5, pid=5, 5.pdf), and for the whole number when it is too large to be a count in this report.
            for (pid in papers.map { it.pid }) {
                val form = Regex("(#|paper |pid |pid=)$pid(?![0-9])|(?<![0-9])$pid\\.pdf", RegexOption.IGNORE_CASE)
                assertFalse(form.containsMatchIn(report), "the report names paper $pid")
                if (pid >= 1000) assertFalse(Regex("(?<![0-9.])$pid(?![0-9.%])").containsMatchIn(report), "the report contains the number $pid")
            }
            assertFalse(report.contains("@"))

            // the same data as an export gives the same report
            val export = dir.resolve("export")
            Files.createDirectories(export)

            fun w(name: String, key: String, items: List<JsonObject>) =
                Files.writeString(
                    export.resolve(name),
                    JsonObject(
                        mapOf(
                            "ok" to JsonPrimitive(true),
                            key to JsonArray(items),
                        ),
                    ).toString(),
                )
            w(
                "pc.json",
                "pc",
                pc.map {
                    JsonObject(
                        mapOf(
                            "email" to JsonPrimitive(it.email),
                            "roles" to JsonPrimitive(it.roles.joinToString(" ")),
                            "tags" to JsonPrimitive(it.tags.joinToString(" ")),
                        ),
                    )
                },
            )
            w(
                "papers.json",
                "papers",
                papers.map { p ->
                    JsonObject(
                        mapOf(
                            "pid" to JsonPrimitive(p.pid),
                            "status" to (p.status?.let { JsonPrimitive(it) } ?: JsonNull),
                            "decision" to (p.decision?.let { JsonPrimitive(it) } ?: JsonNull),
                            "authors" to JsonArray(p.authors.map { JsonObject(mapOf("email" to JsonPrimitive(it))) }),
                            "pc_conflicts" to JsonObject(p.pcConflicts.mapValues { JsonPrimitive(it.value) }),
                        ),
                    )
                },
            )
            w(
                "reviews.json",
                "reviews",
                reviews.map { r ->
                    JsonObject(
                        mapOf(
                            "rid" to JsonPrimitive(r.rid),
                            "pid" to JsonPrimitive(r.pid),
                            "rtype" to JsonPrimitive(r.rtype),
                            "status" to JsonPrimitive(r.status),
                            "round" to (r.round?.let { JsonPrimitive(it) } ?: JsonNull),
                        ) + r.fields,
                    )
                },
            )

            fun norm(s: String) = s.lines().filterNot { it.startsWith("- Data read from") || it.startsWith("- Network used") }.joinToString("\n")
            assertEquals(norm(report), norm(eval(listOf("--export", export.toString()))))
            assertEquals(report, eval(listOf("--token-file", tokenFile.toString())), "two runs on the same conference give the same bytes")
        } finally {
            dir.toFile().deleteRecursively()
        }
    }
}
