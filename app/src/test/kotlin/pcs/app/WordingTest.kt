package pcs.app

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import pcs.core.rules.Discussion
import pcs.testing.Covers
import pcs.testing.Family
import java.nio.file.Files
import java.nio.file.Path

/**
 * The wording rules of spec §7 over the UI's strings: "no comments yet", not "disengaged"; "no in-HotCRP activity", not "absent";
 * and nothing "lazy". The mirror sees who writes, never who reads, so the screens describe what was recorded and never a person's
 * state of mind. Every string literal in the app and in core's main sources is scanned (core builds the reason strings the chips
 * and the drawer show); a literal that is only an identifier (`AC_ABSENT`, the spec's rule name, which no screen shows) is exempt.
 */
@Family("T12")
class WordingTest {
    private val forbidden = Regex("disengaged|absent|lazy", RegexOption.IGNORE_CASE)
    private val literal = Regex("\"(?:[^\"\\\\\\n]|\\\\.)*\"")
    private val identifier = Regex("\"[A-Z][A-Z0-9_]*\"")

    private fun roots(): List<Path> {
        val repo = Path.of(System.getProperty("pcs.repoRoot"))
        return listOf(repo.resolve("app/src/main/kotlin"), repo.resolve("core/src/main/kotlin"))
    }

    /** The offending literals in [source], as "text". */
    internal fun offenders(source: String): List<String> =
        literal.findAll(source).map { it.value }.filter { !identifier.matches(it) && forbidden.containsMatchIn(it) }.toList()

    @Test
    @Covers("view:discussion")
    fun `no UI string says disengaged, absent or lazy`() {
        val bad =
            roots().flatMap { root ->
                Files.walk(root).use { s ->
                    s.filter { it.toString().endsWith(".kt") }.toList()
                }.flatMap { f ->
                    offenders(Files.readString(f)).map { "${root.relativize(f)}: $it" }
                }
            }
        assertEquals(emptyList<String>(), bad, "spec §7 wording")
    }

    @Test
    fun `the scan finds a forbidden word, and lets the rule identifier through`() {
        assertEquals(listOf("\"the AC is absent\""), offenders("val a = \"the AC is absent\""))
        assertEquals(listOf("\"Lazy reviewer\""), offenders("x(\"Lazy reviewer\")"))
        assertEquals(listOf("\"disengaged\""), offenders("\"disengaged\""))
        assertEquals(emptyList<String>(), offenders("Rule(\"AC_ABSENT\", ::acNoComment)"))
        assertEquals(emptyList<String>(), offenders("\"no comments yet\""))
    }

    @Test
    fun `every label the screens put on a rule, a stage or a person is free of the words, and names every rule`() {
        val strings =
            DiscussionText.RULE_LABEL.values + DiscussionText.STAGE_LABEL.values +
                listOf(
                    DiscussionText.NO_POST_YET,
                    DiscussionText.NO_COMMENT_YET,
                    DiscussionText.APPROX_NOTE,
                    DiscussionText.NUDGE_NOTE,
                    DiscussionText.SEE_NOTE,
                    DiscussionText.LOAD_NOTE,
                )
        assertTrue(strings.none { forbidden.containsMatchIn(it) }, strings.toString())
        assertEquals(Discussion.RULES.map { it.name }, DiscussionText.RULE_LABEL.keys.toList(), "a label for each rule of spec 5c, in order")
        assertEquals("No comments yet", DiscussionText.rule("SILENT_DISCUSSION"))
        assertEquals("No AC comment yet", DiscussionText.rule("AC_ABSENT"))
    }
}
