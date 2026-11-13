package pcs.core

import com.sun.jna.Library
import com.sun.jna.Native
import com.sun.jna.Pointer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.Test
import pcs.core.rules.DeskReject
import java.nio.file.Files
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** The native library built by model/ffi/build.sh: the model's `pcs_answer`, in-process. */
interface PcsFfi : Library {
    fun pcs_init(): Int

    fun pcs_query(query: String): Pointer

    fun pcs_free(p: Pointer)
}

/**
 * The Lean-in-core spike (PLAN §A3, M1): the proved model answers decisions inside the JVM.
 * Skipped unless the native library has been built.
 */
class LeanCoreSpikeTest {
    private val lib = Repo.path("model/.lake/build/lib/libpcsffi.so")

    private fun load(): PcsFfi {
        assumeTrue(Files.exists(lib), "native library not built (model/ffi/build.sh)")
        return Native.load(lib.toString(), PcsFfi::class.java)
    }

    private fun PcsFfi.ask(q: String): String {
        val p = pcs_query(q)
        try {
            return p.getString(0)
        } finally {
            pcs_free(p)
        }
    }

    @Test
    fun `the native model answers the whole corpus like the oracle and like the Kotlin rule, across threads`() {
        val ffi = load()
        assertEquals(0, ffi.pcs_init())
        val lines = Files.readAllLines(Repo.path("model/export/oracle-mayRemove.jsonl"))
        val pool = Executors.newFixedThreadPool(8)
        val t0 = System.nanoTime()
        val bad =
            lines.map { line ->
                pool.submit<String?> {
                    val o = Json.parseToJsonElement(line).jsonObject
                    val q = o["query"]!!.jsonObject
                    val expected = o["answer"]!!.jsonObject["result"]!!.jsonPrimitive.boolean
                    val native = Json.parseToJsonElement(ffi.ask(q.toString())).jsonObject["result"]!!.jsonPrimitive.boolean
                    val kotlin =
                        DeskReject.mayRemove(
                            OracleJson.faults(q["mutant"]),
                            OracleJson.readings(q["reading"]!!.jsonObject),
                            OracleJson.referral(q["referral"]!!.jsonObject),
                        )
                    if (native != expected || kotlin != expected) "native=$native kotlin=$kotlin expected=$expected: $line" else null
                }
            }.mapNotNull { it.get() }
        val micros = (System.nanoTime() - t0) / 1000 / lines.size
        pool.shutdown()
        pool.awaitTermination(10, TimeUnit.SECONDS)
        println("lean-in-core spike: ${lines.size} queries on 8 threads, ~$micros µs per query including JSON")
        assertEquals(emptyList<String>(), bad.take(3), "${bad.size} disagreements")
    }
}
