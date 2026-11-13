package pcs.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test
import pcs.core.hotcrp.Strict

class StrictDecodingTest {
    @Test
    fun `an unexpected key or a mistyped one is reported as drift`() {
        val o = Json.parseToJsonElement("""{"rid": 1, "pid": "seven", "OveMer": 3, "brand_new": true}""").jsonObject
        val problems = mutableListOf<String>()
        val s = Strict("reviews[0]", o, problems)
        s.long("rid")
        s.long("pid")
        s.raw("OveMer")
        s.finish()
        assertEquals(listOf("reviews[0].pid: expected number, got \"seven\"", "reviews[0]: unexpected key brand_new"), problems)
    }

    @Test
    fun `a single flag decodes like a list of one`() {
        val o = Json.parseToJsonElement("""{"ratings": "short"}""").jsonObject
        val problems = mutableListOf<String>()
        assertEquals(listOf("short"), Strict("r", o, problems).stringsOrOne("ratings"))
        assertEquals(emptyList<String>(), problems)
    }
}
