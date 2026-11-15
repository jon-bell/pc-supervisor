package net.jonbell.pcs.core

import kotlinx.coroutines.runBlocking
import net.jonbell.pcs.core.hotcrp.HotcrpLinks
import net.jonbell.pcs.core.readings.Answers
import net.jonbell.pcs.core.readings.CardOutcome
import net.jonbell.pcs.core.readings.ModelExport
import net.jonbell.pcs.core.readings.QId
import net.jonbell.pcs.core.secrets.Accounts
import net.jonbell.pcs.core.secrets.Keychain
import net.jonbell.pcs.core.session.Conferences
import net.jonbell.pcs.core.session.MissingSecretException
import net.jonbell.pcs.core.session.Session
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.net.URI
import java.nio.file.Files
import java.nio.file.Path

/** The app shell's plumbing in core (PLAN M4): keychain-held secrets, conference files, cards, links. */
class SessionTest {
    private class MapKeychain : Keychain {
        val m = mutableMapOf<String, String>()
        override val backend = "in-memory test keychain"

        override fun read(account: String) = m[account]

        override fun write(account: String, secret: String) {
            m[account] = secret
        }
    }

    private val repo = Path.of(System.getProperty("pcs.repoRoot"))
    private val synthetic = repo.resolve("model/answers/synthetic.txt")

    private fun conf(dir: Path, id: String, url: String): Path =
        Files.writeString(
            dir.resolve("$id.conf"),
            "PCS_HOTCRP_URL=$url\nPCS_ANSWERS=$synthetic\nPCS_DB_PATH=${dir.resolve("$id.db")}\n",
        )

    @Test
    fun `a new conference gets a fresh DB key in the keychain, and reopening uses it`(
        @TempDir dir: Path,
    ) {
        conf(dir, "conf-a", "https://conf-a.example.org")
        conf(dir, "conf-b", "https://conf-b.example.org")
        val env = mapOf("PCS_CONFERENCES" to dir.toString())
        val confs = Conferences.list(env)
        assertEquals(listOf("conf-a", "conf-b"), confs.map { it.id })
        val kc = MapKeychain()
        Session.open(confs[0], kc, env).close()
        Session.open(confs[1], kc, env).close()
        val a = kc.m[Accounts.dbKey("conf-a")]!!
        assertTrue(a.length >= 40, "a 256-bit key")
        assertFalse(a == kc.m[Accounts.dbKey("conf-b")], "one key per conference")
        Session.open(confs[0], kc, env).use { assertEquals(0L, it.store.count("paper")) }
        assertEquals(a, kc.m[Accounts.dbKey("conf-a")], "reopening keeps the key")
    }

    @Test
    fun `a store whose key is missing from the keychain is not reopened with a new key`(
        @TempDir dir: Path,
    ) {
        conf(dir, "c", "https://c.example.org")
        val env = mapOf("PCS_CONFERENCES" to dir.toString())
        val c = Conferences.list(env).single()
        Session.open(c, MapKeychain(), env).close()
        val e = assertThrows(MissingSecretException::class.java) { Session.open(c, MapKeychain(), env) }
        assertTrue(e.message!!.contains("not in the keychain"))
    }

    @Test
    fun `secrets in the environment count only for the local harness`(
        @TempDir dir: Path,
    ) {
        conf(dir, "real", "https://real.example.org")
        val env = mapOf("PCS_CONFERENCES" to dir.toString())
        val c = Conferences.list(env).single()
        val kc = MapKeychain()
        Session.open(c, kc, env + ("PCS_DB_KEY" to "env-key")).use { s ->
            assertTrue(kc.m.containsKey(Accounts.dbKey("real")), "the env key is ignored for a real instance")
            val e = assertThrows(MissingSecretException::class.java) { runBlocking { s.sync() } }
            assertTrue(e.message!!.contains("pcs secret real"))
        }
    }

    @Test
    fun `cards under the synthetic answers are decided where the answers settle them, blocked where they don't`() {
        val cards = ModelExport.cards.associateBy { it.id }
        assertEquals(44, cards.size)
        val r = Answers.read(synthetic).readings
        // X1 depends only on Q10, which the synthetic answers leave open: every case is still possible.
        val x1 = cards["X1"]!!.under(r) as CardOutcome.Blocked
        assertEquals(listOf(QId.Q10), x1.by)
        assertEquals(cards["X1"]!!.cases.map { it.outcome }, x1.cases.map { it.outcome })
        // X8 depends on Q8 and Q19; Q8 = one settles it whatever Q19 says.
        val x8 = cards["X8"]!!.under(r) as CardOutcome.Decided
        assertEquals(cards["X8"]!!.cases.first { it.reading[QId.Q8] == "one" }.outcome, x8.outcome)
    }

    @Test
    fun `every unresolved question is listed with what it blocks`() {
        val answers = Answers.read(synthetic)
        val blocked = ModelExport.blocked(answers).associateBy { it.question }
        assertEquals(answers.unresolved.toSet(), blocked.keys)
        assertTrue(blocked[QId.Q10]!!.cards.any { it.id == "X1" })
        assertTrue(blocked[QId.Q4]!!.cards.map { it.id }.containsAll(listOf("S12", "S12b")))
        assertTrue(blocked[QId.Q4]!!.policyCells.isNotEmpty(), "Q4 splits the policy table")
        assertTrue(blocked[QId.Q19]!!.cards.none { it.id == "X8" }, "Q8 = one makes Q19 irrelevant to X8")
    }

    @Test
    fun `deep links follow spec section 4`() {
        val l = HotcrpLinks(URI("http://127.0.0.1:8080"))
        assertEquals("http://127.0.0.1:8080/paper/4", l.paper(4))
        assertEquals("http://127.0.0.1:8080/review/4A", l.review(4, "A", 17))
        assertEquals("http://127.0.0.1:8080/review?p=4&r=17", l.review(4, null, 17))
        assertEquals("http://127.0.0.1:8080/search?q=%23chair-attention%20OR%204", l.search("#chair-attention OR 4"))
    }
}
