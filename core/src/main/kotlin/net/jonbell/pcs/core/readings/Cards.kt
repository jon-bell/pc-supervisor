package net.jonbell.pcs.core.readings

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import net.jonbell.pcs.core.rules.Venue

/** One case of an example card: a reading of the card's questions and the model's outcome under it. */
public data class CardCase(val reading: Map<QId, String>, val outcome: String, val venue: Venue? = null)

/** An example card (concepts §3.11), as the Lean model exports it (model/export/cards.json). */
public data class Card(
    val id: String,
    val text: String,
    val deps: List<QId>,
    val cases: List<CardCase>,
    /** The venue parameters the outcome depends on (`nominees-max`, `pattern-min`, `acc-grace-h`); each case then names its venue. */
    val venueDeps: List<String> = emptyList(),
) {
    /**
     * The cases the answers allow: every case that agrees with each answered question it depends on and, for a card
     * with venue parameters, runs under [venue]. The model tried a few values of each parameter; a value it did not try
     * falls back to the defaults.
     */
    public fun candidates(r: Readings, venue: Venue = Venue()): List<CardCase> {
        val byReading = cases.filter { c -> c.reading.all { (q, key) -> r[q]?.let { it.key == key } ?: true } }
        if (venueDeps.isEmpty()) return byReading
        val exact = byReading.filter { it.venue == venue.restrictedTo(venueDeps) }
        return exact.ifEmpty { byReading.filter { it.venue == Venue().restrictedTo(venueDeps) } }
    }

    /** The card under a reading: decided when every allowed case has the same outcome, else blocked. */
    public fun under(r: Readings, venue: Venue = Venue()): CardOutcome {
        val cs = candidates(r, venue)
        val outcomes = cs.map { it.outcome }.distinct()
        if (outcomes.size == 1) return CardOutcome.Decided(outcomes.single())
        return CardOutcome.Blocked(blockers(cs), cs)
    }

    /** The unresolved questions whose answer changes the outcome among [cs]. */
    private fun blockers(cs: List<CardCase>): List<QId> =
        deps.filter { q ->
            cs.any { a -> cs.any { b -> a.outcome != b.outcome && a.reading[q] != b.reading[q] } }
        }
}

/** What a card says under the answered reading. */
public sealed interface CardOutcome {
    public data class Decided(val outcome: String) : CardOutcome

    /** The answers leave [by] open, and the outcome depends on them; [cases] are the outcomes still possible. */
    public data class Blocked(val by: List<QId>, val cases: List<CardCase>) : CardOutcome
}

/**
 * A policy cell (concepts §3.9) that is a ruling on [question]. [byQ4] is what it grants under
 * each reading of Q4, the only question the exported table is split by.
 */
public data class PolicyCell(val role: String, val perm: String, val question: QId, val byQ4: Map<String, String>)

/**
 * What an unresolved question blocks. There is no per-feature dependency map yet, so this is
 * derived from the model's export: the example cards whose outcome turns on the question under
 * the answered readings, and the policy cells that are rulings on it (†Q in concepts §3.9).
 */
public data class Blocked(val question: QId, val cards: List<Card>, val policyCells: List<PolicyCell>)

/** The parts of the Lean model's export (model/export) that `core` ships as resources. */
public object ModelExport {
    private fun resource(name: String): String =
        ModelExport::class.java.getResource("/net/jonbell/pcs/model/$name")?.readText()
            ?: error("model export $name missing from the classpath; :core:processResources copies model/export")

    public val cards: List<Card> by lazy { parseCards(resource("cards.json")) }

    /** Policy cells that are rulings on an open question. */
    public val rulingCells: List<PolicyCell> by lazy { parseRulingCells(resource("policy.json")) }

    public fun parseCards(json: String): List<Card> =
        Json.parseToJsonElement(json).jsonArray.map { e ->
            val o = e.jsonObject

            fun q(code: String) = QId.ofCode(code) ?: error("card ${o["id"]}: unknown question $code")
            Card(
                id = o["id"]!!.jsonPrimitive.content,
                text = o["text"]!!.jsonPrimitive.content,
                deps = o["deps"]!!.jsonArray.map { q(it.jsonPrimitive.content) },
                venueDeps = o["venueDeps"]?.jsonArray?.map { it.jsonPrimitive.content }.orEmpty(),
                cases =
                    o["cases"]!!.jsonArray.map { c ->
                        val co = c.jsonObject
                        CardCase(
                            (co["reading"] as JsonObject).mapKeys { q(it.key) }.mapValues { it.value.jsonPrimitive.content },
                            co["outcome"]!!.jsonPrimitive.content,
                            (co["venue"] as? JsonObject)?.let { v ->
                                Venue(
                                    v["nomineesMax"]!!.jsonPrimitive.content.toInt(),
                                    v["patternMin"]!!.jsonPrimitive.content.toInt(),
                                    v["accGraceH"]!!.jsonPrimitive.content.toLong(),
                                )
                            },
                        )
                    },
            )
        }

    /** Cells marked as a ruling (†Q in concepts §3.9), with what each Q4 reading grants. */
    public fun parseRulingCells(json: String): List<PolicyCell> {
        val by = Json.parseToJsonElement(json).jsonObject["byQ4"]!!.jsonArray.map { it.jsonObject }
        val tables =
            by.associate { t ->
                t["q4"]!!.jsonPrimitive.content to
                    t["cells"]!!.jsonArray.associate { c ->
                        val co = c.jsonObject
                        (co["role"]!!.jsonPrimitive.content to co["perm"]!!.jsonPrimitive.content) to co["cell"]!!.jsonObject
                    }
            }
        return tables.values.first().mapNotNull { (k, cell) ->
            if (cell["kind"]?.jsonPrimitive?.content != "ruling") return@mapNotNull null
            // a ruling may rest on something other than an open question (a HotCRP setting); only questions block
            val q = QId.ofCode(cell["question"]?.jsonPrimitive?.content.orEmpty()) ?: return@mapNotNull null
            PolicyCell(
                k.first,
                k.second,
                q,
                tables.mapValues { (_, t) ->
                    val c = t[k]!!
                    val scope = c["scope"]?.jsonPrimitive?.content.orEmpty()
                    val granted = c["granted"]?.jsonPrimitive?.content == "true"
                    (if (granted) "granted" else "denied") + if (scope.isNotEmpty()) " ($scope)" else ""
                },
            )
        }
    }

    /** Every unresolved question, with what it blocks under [answers]. */
    public fun blocked(
        answers: Answers,
        cards: List<Card> = this.cards,
        cells: List<PolicyCell> = this.rulingCells,
        venue: Venue = Venue(),
    ): List<Blocked> =
        answers.unresolved.map { q ->
            Blocked(
                q,
                cards.filter { c -> (c.under(answers.readings, venue) as? CardOutcome.Blocked)?.by?.contains(q) == true },
                cells.filter { it.question == q },
            )
        }
}
