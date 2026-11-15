package net.jonbell.pcs.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import net.jonbell.pcs.core.readings.Answers
import net.jonbell.pcs.core.readings.Q2
import net.jonbell.pcs.core.readings.QId
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.nio.file.Files

class AnswersTest {
    @Test
    fun `the JVM and Lean parsers agree on the synthetic answers`() {
        val lean = Json.parseToJsonElement(Files.readString(Repo.path("model/export/answers-synthetic.json"))).jsonObject
        val leanGiven = lean["given"]!!.jsonArray.map { it.jsonArray[0].jsonPrimitive.content to it.jsonArray[1].jsonPrimitive.content }
        val ours = Answers.read(Repo.path("model/answers/synthetic.txt"))
        assertEquals(leanGiven, ours.given.map { it.first.code to it.second })
        assertEquals(lean["errors"]!!.jsonArray.size, ours.errors.size)
    }

    @Test
    fun `unknown readings and questions are errors, and unanswered questions are unresolved`() {
        val a = Answers.parse("Q2 = vote\nQ3 = whenever\nQ99 = x\nnonsense\nscale.papers = 10 # ok\n")
        assertEquals(Q2.VOTE, a.readings.q2)
        assertEquals(3, a.errors.size, a.errors.toString())
        assertTrue(QId.Q3 in a.unresolved)
        assertTrue(QId.Q2 !in a.unresolved)
    }
}
