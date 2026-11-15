package net.jonbell.pcs.app

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Surface
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.unit.dp
import net.jonbell.pcs.app.testing.AppDriver
import net.jonbell.pcs.app.testing.Fixtures
import net.jonbell.pcs.app.testing.ViewReader
import net.jonbell.pcs.app.testing.runUi
import net.jonbell.pcs.app.testing.screenshot
import net.jonbell.pcs.core.readings.Answers
import net.jonbell.pcs.core.readings.CardOutcome
import net.jonbell.pcs.core.readings.ModelExport
import net.jonbell.pcs.core.readings.QId
import net.jonbell.pcs.testing.CoversLog
import net.jonbell.pcs.testing.Family
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Tag
import org.junit.jupiter.api.Test
import java.io.File

/** The card gallery (PLAN M4, T12): one screen per example card, rendered under the answered reading. */
@Tag("ui")
@Family("T12")
@OptIn(ExperimentalTestApi::class)
class CardGalleryUiTest {
    private val readings = Answers.read(Fixtures.syntheticAnswers).readings

    @Test
    fun `every card in the export has a screen that says what the model says`() {
        val cards = ModelExport.cards
        assertEquals(44, cards.size, "the model exports 44 example cards")
        runUi {
            var current by mutableStateOf(cards.first())
            setContent {
                PcsTheme(screenshotMode = true) {
                    Surface { Box(Modifier.padding(24.dp)) { CardScreen(current, readings) } }
                }
            }
            val view = ViewReader(this)
            for (card in cards) {
                current = card
                waitForIdle()
                val v = view.card()
                assertEquals(card.text, v.text, "card ${card.id}: its statement")
                assertEquals(card.deps.map { it.code }.toSet(), v.deps.keys, "card ${card.id}: its questions")
                when (val o = card.under(readings)) {
                    is CardOutcome.Decided -> {
                        assertEquals(o.outcome, v.outcome, "card ${card.id}: the outcome under the answered reading")
                        assertEquals(null, v.blockedBy)
                    }
                    is CardOutcome.Blocked -> {
                        assertEquals(o.by.joinToString { it.code }, v.blockedBy?.removePrefix("Blocked by "), "card ${card.id}: what blocks it")
                        assertEquals(null, v.outcome)
                    }
                }
                screenshot("cards/card-${card.id}")
                CoversLog.record("CardGalleryUiTest/${card.id}", "view:card-${card.id}", "pass", "T12")
            }
        }
        val shots = File(System.getProperty("pcs.screenshots"), "cards").listFiles { f -> f.extension == "png" }!!
        assertEquals(cards.map { "card-${it.id}.png" }.toSet(), shots.map { it.name }.toSet(), "one screenshot per card, and no others")
    }

    @Test
    fun `under a fully answered file every card shows its resolved outcome and nothing is blocked`() {
        val answers = Answers.read(Fixtures.completeAnswers)
        assertEquals(emptyList<QId>(), answers.unresolved, "the file answers every question")
        assertEquals(emptyList<String>(), answers.errors, "and has no errors")
        assertEquals(QId.entries.size, answers.given.size, "every question is answered once")
        val cards = ModelExport.cards
        val complete = answers.readings
        runUi {
            var current by mutableStateOf(cards.first())
            setContent {
                PcsTheme(screenshotMode = true) {
                    Surface { Box(Modifier.padding(24.dp)) { CardScreen(current, complete) } }
                }
            }
            val view = ViewReader(this)
            for (card in cards) {
                current = card
                waitForIdle()
                val v = view.card()
                val o = card.under(complete)
                assertTrue(o is CardOutcome.Decided, "card ${card.id} is blocked under the complete file: $o")
                assertEquals((o as CardOutcome.Decided).outcome, v.outcome, "card ${card.id}: the resolved outcome")
                assertEquals(null, v.blockedBy, "card ${card.id}: nothing blocks it")
                assertTrue(v.outcome!!.isNotBlank(), "card ${card.id} shows an outcome")
            }
        }
    }

    @Test
    fun `the gallery tab lists every card and shows the one picked`() {
        val cards = ModelExport.cards
        runUi {
            setContent { PcsTheme(screenshotMode = true) { Surface { CardGallery(readings) } } }
            val driver = AppDriver(this)
            val view = ViewReader(this)
            assertEquals(cards.first().text, view.card().text)
            val second = cards[1]
            driver.click("card-link-${second.id}")
            assertEquals(second.text, view.card().text)
        }
    }
}
