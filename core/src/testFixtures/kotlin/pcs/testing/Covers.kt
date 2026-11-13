package pcs.testing

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.extension.AfterTestExecutionCallback
import org.junit.jupiter.api.extension.BeforeTestExecutionCallback
import org.junit.jupiter.api.extension.ExtensionContext
import java.io.File

/**
 * The claims a test is evidence for (PLAN §A2): `prop:S1`, `card:E7`, `rule:may-remove`, ...
 * Claims a test discovers at run time (one per card case) are reported with [CoversLog.record].
 */
@Target(AnnotationTarget.CLASS, AnnotationTarget.FUNCTION)
@Retention(AnnotationRetention.RUNTIME)
public annotation class Covers(vararg val claims: String)

/** The claim inventory written by `:core:claimsInventory`. */
public object Claims {
    public val ids: Set<String> by lazy {
        val path = System.getProperty("pcs.claimsFile") ?: error("pcs.claimsFile not set; run tests through Gradle")
        Json.parseToJsonElement(File(path).readText()).jsonArray
            .map { it.jsonObject["id"]!!.jsonPrimitive.content }.toSet()
    }

    public fun requireKnown(id: String) {
        require(id in ids) { "unknown claim ID $id: not in the inventory (PLAN §A2). Fix the ID or add the claim to the specification." }
    }
}

/** Appends one line per (test, claim, outcome) under build/covers/, for the assurance report. */
public object CoversLog {
    private val dir: File? = System.getProperty("pcs.coversDir")?.let { File(it).apply { mkdirs() } }

    @Synchronized
    public fun record(test: String, claim: String, outcome: String, family: String) {
        Claims.requireKnown(claim)
        dir?.resolve("covers.tsv")?.appendText("$family\t$claim\t$outcome\t$test\n")
    }
}

/**
 * Registered for every test (META-INF/services plus `junit.jupiter.extensions.autodetection.enabled`).
 * Fails a test that names an unknown claim, and records the claims of annotated tests.
 */
public class CoversExtension : BeforeTestExecutionCallback, AfterTestExecutionCallback {
    private fun claimsOf(ctx: ExtensionContext): Pair<String, List<String>> {
        val m = ctx.testMethod.orElse(null)?.getAnnotation(Covers::class.java)?.claims?.toList().orEmpty()
        val c = ctx.testClass.orElse(null)?.getAnnotation(Covers::class.java)?.claims?.toList().orEmpty()
        val fam = ctx.testClass.orElse(null)?.getAnnotation(Family::class.java)?.name ?: "unit"
        return fam to (c + m)
    }

    override fun beforeTestExecution(ctx: ExtensionContext) {
        claimsOf(ctx).second.forEach(Claims::requireKnown)
    }

    override fun afterTestExecution(ctx: ExtensionContext) {
        val (fam, ids) = claimsOf(ctx)
        val outcome = if (ctx.executionException.isPresent) "fail" else "pass"
        ids.forEach { CoversLog.record(ctx.uniqueId, it, outcome, fam) }
    }
}

/** The test family of PLAN §A5 (T1 ... T12) a test class belongs to. */
@Target(AnnotationTarget.CLASS)
@Retention(AnnotationRetention.RUNTIME)
public annotation class Family(val name: String)
