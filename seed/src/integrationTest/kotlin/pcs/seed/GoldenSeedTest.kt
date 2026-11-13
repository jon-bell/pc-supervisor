package pcs.seed

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestInstance
import pcs.core.config.Settings
import pcs.core.hotcrp.Comment
import pcs.core.hotcrp.HotcrpClient
import pcs.core.hotcrp.Review
import java.net.URI
import java.nio.file.Path
import kotlin.math.abs

/**
 * PLAN M2's acceptance test: the harness, freshly seeded with `golden`
 * (`./gradlew :seed:run --args=golden`), holds exactly what the contract table describes,
 * read back through `core`'s strict client. The rules that fire are M18's to test.
 */
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class GoldenSeedTest {
    private lateinit var reviews: List<Review>
    private lateinit var comments: List<Comment>
    private lateinit var decided: List<Long>
    private val url = URI(System.getenv("PCS_HOTCRP_URL") ?: error("PCS_HOTCRP_URL not set"))
    private val driver by lazy { Driver(url, System.getenv("PCS_HOTCRP_TOKEN")!!, Path.of(System.getProperty("pcs.repoRoot"))) }

    @BeforeAll
    fun read() =
        runBlocking {
            check(Settings.isLocalhost(url))
            HotcrpClient(url, System.getenv("PCS_HOTCRP_TOKEN")!!, chunk = 5).use { c ->
                val pids = c.paperIds()
                reviews = c.reviews(pids)
                comments = c.comments(pids)
            }
            decided = searchIds("dec:yes")
        }

    private fun searchIds(q: String): List<Long> {
        val http = java.net.http.HttpClient.newHttpClient()
        val req =
            java.net.http.HttpRequest.newBuilder(URI("$url/api/search?q=${java.net.URLEncoder.encode(q, Charsets.UTF_8)}&pretty=0"))
                .header("Authorization", "Bearer ${System.getenv("PCS_HOTCRP_TOKEN")}").build()
        val body = http.send(req, java.net.http.HttpResponse.BodyHandlers.ofString()).body()
        return Regex("\"ids\":\\[([0-9,]*)]").find(body)!!.groupValues[1].split(",").filter { it.isNotEmpty() }.map { it.toLong() }
    }

    private fun complete(pid: Int) = reviews.filter { it.pid == pid.toLong() && it.status == "complete" }

    private fun merits(pid: Int) = complete(pid).map { (it.fields["OveMer"] as JsonPrimitive).content.toInt() }.sorted()

    private fun rev(pid: Int, who: String) = reviews.first { it.pid == pid.toLong() && it.reviewerEmail == who }

    @Test
    fun `thirteen papers, each with one AC`() {
        assertEquals((1L..13L).toList(), reviews.map { it.pid }.distinct().sorted())
        assertTrue((1L..13L).all { pid -> reviews.count { it.pid == pid && it.rtype == 5 } == 1 })
    }

    @Test
    fun `review counts and final merits match the table`() {
        val expected =
            mapOf(
                1 to listOf(3, 3, 4),
                2 to listOf(3, 4),
                3 to listOf(2, 4, 4),
                4 to listOf(2, 4, 4),
                5 to listOf(2, 2, 2),
                6 to listOf(4, 4, 4),
                7 to listOf(3, 3, 4),
                8 to listOf(3, 3, 5),
                9 to listOf(3, 3, 4),
                10 to listOf(3, 3, 4),
                11 to listOf(3, 3, 4),
                12 to listOf(2, 4, 4),
                13 to listOf(3, 3, 4),
            )
        expected.forEach { (pid, m) -> assertEquals(m, merits(pid), "pid $pid") }
        assertEquals("empty", rev(2, Golden.nLaggard).status, "pid 2: the nominee's review is still empty")
        assertTrue(complete(9).all { (it.fields["RevExp"] as JsonPrimitive).content.toInt() <= 2 }, "pid 9: low expertise")
    }

    @Test
    fun `timestamps land where the scenario puts them (within a minute)`() {
        for (ev in Golden.scenario.events.filterIsInstance<SubmitReview>()) {
            val change = Golden.scenario.events.filterIsInstance<ChangeScore>().firstOrNull { it.pid == ev.pid && it.reviewer == ev.reviewer }
            val want = driver.epoch(change?.at ?: ev.at)
            val got = rev(ev.pid, ev.reviewer).modifiedAt!!
            assertTrue(abs(got - want) <= 60, "pid ${ev.pid} ${ev.reviewer}: modified_at $got, wanted $want")
        }
        val byPid = comments.groupBy { it.pid.toInt() }
        for (ev in Golden.scenario.events.filterIsInstance<PostComment>()) {
            val want = driver.epoch(ev.at)
            assertTrue(
                byPid[ev.pid].orEmpty().any {
                    it.authorEmail == ev.author && abs(it.modifiedAt!! - want) <= 60
                },
                "comment on ${ev.pid} by ${ev.author} at $want",
            )
        }
    }

    @Test
    fun `discussion shape per row`() {
        val byPid = comments.groupBy { it.pid.toInt() }
        assertTrue(byPid[5].isNullOrEmpty(), "pid 5: no comments at all")
        assertTrue(byPid[7].orEmpty().none { it.authorEmail == "ac-idle@example.org" }, "pid 7: the AC never comments")
        assertTrue(byPid[4].orEmpty().any { it.authorEmail == Golden.acBusy && it.text!!.contains("@${Golden.rPinged}") }, "pid 4: the AC pings R-pinged")
        assertTrue(byPid.values.flatten().none { it.authorEmail == Golden.rSilent || it.authorEmail == Golden.rPinged }, "R-silent and R-pinged never comment")
        val resp = byPid[11].orEmpty().filter { it.response }
        assertEquals(1, resp.size, "pid 11: one author response")
        assertTrue(byPid[11].orEmpty().filter { !it.response }.all { it.authorEmail == "ac-normal@example.org" }, "pid 11: only the AC comments")
        assertEquals(2L, byPid[6].orEmpty().maxOf { it.modifiedAt!! }.let { (it - driver.epoch(At.disc(0))) / 86400 }, "pid 6: last comment on day +2")
    }

    @Test
    fun `ratings and the decision`() {
        assertEquals(listOf("short", "short"), rev(10, "r1@example.org").ratings, "pid 10: rated short by both co-reviewers")
        assertEquals(listOf("disrespectful", "short"), rev(13, "r3@example.org").ratings.sorted(), "pid 13: disrespectful and short")
        assertEquals(listOf(1L), decided, "only pid 1 has a decision")
    }
}
