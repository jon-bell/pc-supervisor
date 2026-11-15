package net.jonbell.pcs.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import net.jonbell.pcs.core.readings.QId
import net.jonbell.pcs.core.readings.Readings
import net.jonbell.pcs.core.rules.DeskReject
import net.jonbell.pcs.core.rules.Faults
import net.jonbell.pcs.core.rules.Ground
import net.jonbell.pcs.core.rules.Opinion
import net.jonbell.pcs.core.rules.Referral
import net.jonbell.pcs.core.rules.Stage
import net.jonbell.pcs.core.rules.Tier
import net.jonbell.pcs.testing.Covers
import net.jonbell.pcs.testing.Family
import net.jqwik.api.Arbitraries
import net.jqwik.api.Arbitrary
import net.jqwik.api.Combinators
import net.jqwik.api.ForAll
import net.jqwik.api.Property
import net.jqwik.api.Provide
import net.jqwik.api.lifecycle.AfterContainer
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.io.BufferedReader
import java.io.BufferedWriter
import java.nio.file.Files

/** Decoding of oracle queries into `core` types, shared by the corpus and live tests. */
object OracleJson {
    fun readings(o: JsonObject): Readings =
        o.entries.filter { it.key != "venue" }.fold(Readings()) { r, (q, v) -> r.with(QId.ofCode(q)!!, v.jsonPrimitive.content)!! }.base()

    /** The venue parameters a query or card case carries (`venue` object), or the defaults. */
    fun venue(o: JsonElement?): net.jonbell.pcs.core.rules.Venue {
        val v = (o as? JsonObject) ?: return net.jonbell.pcs.core.rules.Venue()
        return net.jonbell.pcs.core.rules.Venue(
            nomineesMax = v["nomineesMax"]!!.jsonPrimitive.int,
            patternMin = v["patternMin"]!!.jsonPrimitive.int,
            accGraceH = v["accGraceH"]!!.jsonPrimitive.long,
        )
    }

    fun faults(e: JsonElement?): Faults = if (e == null || e is JsonNull) Faults.NONE else Faults.MUTANTS[e.jsonPrimitive.int]

    fun referral(o: JsonObject): Referral {
        fun b(k: String) = o[k]?.jsonPrimitive?.booleanOrNull ?: false

        fun l(k: String) = (o[k] as? JsonPrimitive)?.long ?: 0L
        return Referral(
            ac = l("ac"),
            ground = Ground.ofKey(o["ground"]!!.jsonPrimitive.content)!!,
            opinions =
                (o["opinions"] as? JsonArray).orEmpty().map { op ->
                    val p = op.jsonObject
                    Opinion(
                        who = (p["who"] as? JsonPrimitive)?.long ?: 0,
                        isAc = p["isAc"]?.jsonPrimitive?.booleanOrNull ?: false,
                        tier =
                            when ((p["tier"] as? JsonPrimitive)?.takeIf { it.isString }?.content) {
                                "senior" -> Tier.SENIOR
                                "junior" -> Tier.JUNIOR
                                else -> null
                            },
                        conflicted = p["conflicted"]?.jsonPrimitive?.booleanOrNull ?: false,
                        agrees = p["agrees"]?.jsonPrimitive?.booleanOrNull ?: true,
                    )
                },
            stage = Stage.ofKey(o["stage"]?.jsonPrimitive?.content ?: "screening")!!,
            remedyOffered = b("remedyOffered"),
            remedyDue = l("remedyDue"),
            cured = b("cured"),
            warned = b("warned"),
            askedAt = l("askedAt"),
            now = l("now"),
        )
    }

    fun encode(r: Readings): JsonObject = JsonObject(QId.entries.associate { it.code to JsonPrimitive(r[it]!!.key) })

    fun encode(ref: Referral): JsonObject =
        JsonObject(
            mapOf(
                "ac" to JsonPrimitive(ref.ac),
                "ground" to JsonPrimitive(ref.ground.key),
                "stage" to JsonPrimitive(ref.stage.key),
                "opinions" to
                    JsonArray(
                        ref.opinions.map { o ->
                            JsonObject(
                                mapOf(
                                    "who" to JsonPrimitive(o.who),
                                    "isAc" to JsonPrimitive(o.isAc),
                                    "tier" to (o.tier?.let { JsonPrimitive(it.name.lowercase()) } ?: JsonNull),
                                    "conflicted" to JsonPrimitive(o.conflicted),
                                    "agrees" to JsonPrimitive(o.agrees),
                                ),
                            )
                        },
                    ),
                "remedyOffered" to JsonPrimitive(ref.remedyOffered),
                "remedyDue" to JsonPrimitive(ref.remedyDue),
                "cured" to JsonPrimitive(ref.cured),
                "warned" to JsonPrimitive(ref.warned),
                "askedAt" to JsonPrimitive(ref.askedAt),
                "now" to JsonPrimitive(ref.now),
            ),
        )
}

/**
 * T2 (PLAN §A5) for `rule:may-remove`: the Kotlin rule against the Lean model, on the committed
 * corpus (every build) and on fresh random inputs asked of the live oracle (when it is built).
 */
@Family("T2")
@Covers("rule:may-remove")
class MayRemoveDifferentialTest {
    @Test
    fun `agrees with the oracle corpus, including under every mutant`() {
        val lines = Files.readAllLines(Repo.path("model/export/oracle-mayRemove.jsonl"))
        assertTrue(lines.size >= 1000)
        val disagreements =
            lines.mapNotNull { line ->
                val o = Json.parseToJsonElement(line).jsonObject
                val q = o["query"]!!.jsonObject
                val expected = o["answer"]!!.jsonObject["result"]!!.jsonPrimitive.boolean
                val got =
                    DeskReject.mayRemove(
                        OracleJson.faults(q["mutant"]),
                        OracleJson.readings(q["reading"]!!.jsonObject),
                        OracleJson.referral(q["referral"]!!.jsonObject),
                    )
                if (got != expected) line else null
            }
        assertEquals(emptyList<String>(), disagreements.take(3), "${disagreements.size} of ${lines.size} disagree")
    }
}

/** The live oracle process (`lake exe oracle`), started once per test class if it has been built. */
object LiveOracle {
    private val bin = Repo.path("model/.lake/build/bin/oracle")
    val available: Boolean get() = Files.isExecutable(bin)
    private val proc: Process? by lazy { if (available) ProcessBuilder(bin.toString()).start() else null }
    private val out: BufferedWriter? by lazy { proc?.outputStream?.bufferedWriter() }
    private val inp: BufferedReader? by lazy { proc?.inputStream?.bufferedReader() }

    @Synchronized
    fun ask(query: JsonObject): JsonObject {
        out!!.write(query.toString())
        out!!.newLine()
        out!!.flush()
        return Json.parseToJsonElement(inp!!.readLine()).jsonObject
    }

    fun close() {
        proc?.destroy()
    }
}

@Family("T2")
@Covers("rule:may-remove")
class MayRemoveLiveOracleProperties {
    @Provide
    fun readings(): Arbitrary<Readings> {
        val perQ = QId.entries.map { q -> Arbitraries.of(q.readings.map { it.key }).map { k -> q to k } }
        return Combinators.combine(perQ).`as` { pairs -> pairs.fold(Readings()) { r, (q, k) -> r.with(q, k)!! } }
    }

    @Provide
    fun referrals(): Arbitrary<Referral> {
        val opinion =
            Combinators.combine(
                Arbitraries.longs().between(0, 4),
                Arbitraries.of(true, false),
                Arbitraries.of(Tier.SENIOR, Tier.JUNIOR, null),
                Arbitraries.of(false, false, false, true),
                Arbitraries.of(true, true, true, false),
            ).`as` { who, isAc, tier, conf, agrees -> Opinion(who, isAc, tier, conf, agrees) }
        return Combinators.combine(
            Arbitraries.longs().between(0, 3),
            Arbitraries.of(*Ground.entries.toTypedArray()),
            opinion.list().ofMaxSize(4),
            Arbitraries.of(*Stage.entries.toTypedArray()),
            Arbitraries.of(true, false),
            Arbitraries.longs().between(0, 100),
            Arbitraries.of(true, false),
            Arbitraries.longs().between(0, 200),
        ).`as` { ac, g, ops, st, warned, due, cured, now ->
            Referral(ac, g, ops, st, remedyOffered = due % 2 == 0L, remedyDue = due, cured = cured, warned = warned, askedAt = due, now = now)
        }
    }

    @Property(tries = 10000)
    fun `the Kotlin rule gives the oracle's answer`(
        @ForAll("readings") r: Readings,
        @ForAll("referrals") ref: Referral,
    ) {
        if (!LiveOracle.available) return
        tries.incrementAndGet()
        val a =
            LiveOracle.ask(
                JsonObject(
                    mapOf(
                        "q" to JsonPrimitive("mayRemove"),
                        "reading" to OracleJson.encode(r),
                        "mutant" to JsonNull,
                        "referral" to OracleJson.encode(ref),
                    ),
                ),
            )
        assertEquals(a["result"]!!.jsonPrimitive.boolean, DeskReject.mayRemove(Faults.NONE, r, ref), "reading $r, referral $ref")
    }

    companion object {
        /** jqwik doesn't run JUnit extensions, so this class records its own evidence, and only if the oracle answered. */
        private val tries = java.util.concurrent.atomic.AtomicInteger()

        @JvmStatic
        @AfterContainer
        fun stop() {
            LiveOracle.close()
            if (tries.get() >
                0
            ) {
                net.jonbell.pcs.testing.CoversLog.record("MayRemoveLiveOracleProperties (${tries.get()} tries)", "rule:may-remove", "pass", "T2")
            }
        }
    }
}
