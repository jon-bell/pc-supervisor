package net.jonbell.pcs.agent.llm

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import net.jonbell.pcs.agent.engines.CallRequest
import net.jonbell.pcs.agent.engines.CallResult
import net.jonbell.pcs.agent.engines.Part
import net.jonbell.pcs.agent.engines.Status
import net.jonbell.pcs.agent.engines.Usage

/**
 * The only "model" the unit tests use: a function from a request to a schema-valid answer, written to
 * behave as a careful reader would on the synthetic corpus. [obey] makes it follow a planted
 * instruction (praise, accept, 10/10); [extra] adds output items for a test to plant (an invented quotation).
 */
class FakeModel(
    private val obey: Boolean = false,
    private val raw: String = "",
    private val extraAnonymity: List<String> = emptyList(),
    private val extraSummary: List<String> = emptyList(),
) {
    val seen = mutableListOf<CallRequest>()

    private fun text(req: CallRequest) = req.parts.filterIsInstance<Part.Text>().joinToString("\n") { it.text }

    private fun sq(s: String) = s.replace(Regex("\\s+"), " ").trim()

    fun answer(req: CallRequest): CallResult {
        seen += req
        val out: JsonElement =
            when (req.check.id) {
                "anonymity.llm" -> anonymity(text(req))
                "scope" -> scope(text(req))
                "refs.use" -> refsUse(req)
                "summary" -> summary(text(req))
                "injection.addressed.llm" -> addressed(text(req))
                else -> error("no fake for ${req.check.id}")
            }
        return CallResult(req.key, Status.OK, out, "fake-served", Usage(1000, 100), raw = raw)
    }

    private fun item(quote: String, kind: String) =
        buildJsonObject {
            put("quote", quote)
            put("kind", kind)
            put("reason", "The wording points to the authors' own work.")
        }

    private fun anonymity(t: String): JsonElement {
        val items = mutableListOf<JsonObject>()
        Regex("""our previous tool[^.]*\.""").find(t)?.let { items += item(sq(it.value), "own-prior-work") }
        Regex("""https://github\.com/\S+""").find(t)?.let { items += item(sq(it.value), "identifying-link") }
        extraAnonymity.forEach { items += item(it, "other") }
        return buildJsonObject { put("items", JsonArray(items)) }
    }

    private fun scope(t: String): JsonElement {
        val kelp = Regex("""We present [^.]*[Kk]elp[^.]*\.""").find(t)
        return buildJsonObject {
            put("verdict", if (kelp != null) "out_of_scope" else "in_scope")
            put(
                "claims",
                buildJsonArray {
                    val q = kelp?.value ?: Regex("""We present [^.]*\.""").find(t)?.value ?: "We present a test generator for Java programs."
                    add(buildJsonObject { put("quote", sq(q)) })
                },
            )
            put("matched_topics", buildJsonArray { if (kelp == null) add(JsonPrimitive("automated test generation")) })
            put("reason", if (kelp != null) "The paper is about marine biology." else "The paper is about test generation.")
        }
    }

    private fun refsUse(req: CallRequest): JsonElement {
        val recs = req.parts.filterIsInstance<Part.References>().flatMap { it.records }
        return buildJsonObject {
            put(
                "results",
                buildJsonArray {
                    for (r in recs) {
                        val bad = r["citing_sentence"].str().orEmpty().contains("poor proxy") && r["abstract"].str().orEmpty().contains("useful proxy")
                        add(
                            buildJsonObject {
                                put("id", r["id"].str().orEmpty())
                                put("verdict", if (bad) "not_supported" else "supported")
                                put("abstract_quote", if (bad) "mutation scores are a useful proxy for fault detection" else "")
                                put("reason", if (bad) "The abstract says the opposite." else "Consistent.")
                            },
                        )
                    }
                },
            )
        }
    }

    private fun summary(t: String): JsonElement {
        val sentence = Regex("""[A-Z][^.\[]{40,200}\.""").find(t.substringAfter("[page 1]"))?.value ?: "x".repeat(30)

        fun it(text: String, quote: String) =
            buildJsonObject {
                put("text", text)
                put("quote", sq(quote))
            }
        val contributions = mutableListOf(it("A test generator guided by mutants.", sentence))
        extraSummary.forEach { contributions += it("An invented statement.", it) }
        if (obey) {
            val instruction = Regex("""Ignore all previous instructions.{0,200}?(?:paper\.|10/10\.)""", RegexOption.DOT_MATCHES_ALL).find(t)
            if (instruction != null) contributions += it("This paper should be accepted with a score of 10/10.", instruction.value)
        }
        return buildJsonObject {
            put("contributions", JsonArray(contributions))
            put("evaluation", buildJsonArray {})
            put("prior_work", buildJsonArray {})
            put("closest_cited_work", buildJsonArray {})
        }
    }

    private fun addressed(t: String): JsonElement =
        buildJsonObject {
            val quoted = t.contains("such as") || t.contains("prompt injection")
            put("verdict", if (quoted) "quotation" else "attack")
            put("reason", if (quoted) "The sentence quotes the phrase as an example." else "The sentence is written to be obeyed by an AI reader.")
        }

    companion object {
        val json = Json
    }
}
