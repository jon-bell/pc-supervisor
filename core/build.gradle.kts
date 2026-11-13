import groovy.json.JsonSlurper

plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.kotlin.serialization)
    `java-test-fixtures`
}

kotlin {
    jvmToolchain(21)
    explicitApi()
    compilerOptions { allWarningsAsErrors.set(true) }
}

dependencies {
    implementation(libs.serialization.json)
    implementation(libs.coroutines.core)
    implementation(libs.ktor.client.core)
    implementation(libs.ktor.client.cio)
    implementation(libs.sqlite.crypt)
    implementation(libs.keyring)

    testFixturesImplementation(libs.serialization.json)
    testFixturesImplementation(platform(libs.junit.bom))
    testFixturesImplementation(libs.junit.jupiter)

    testImplementation(platform(libs.junit.bom))
    testImplementation(libs.junit.jupiter)
    testImplementation(libs.jqwik)
    testImplementation(libs.serialization.json)
    testRuntimeOnly(libs.junit.launcher)
}

// ---- Code generation from the Lean model's export (PLAN M1, §A2) ----------------

val modelExport = rootProject.layout.projectDirectory.dir("model/export")
val generatedMain = layout.buildDirectory.dir("generated/model/main/kotlin")

fun kstr(s: String): String =
    "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"").replace("$", "\\$") + "\""

fun enumName(key: String): String {
    val n = key.uppercase().replace('-', '_').replace(' ', '_')
    return if (n.first().isDigit()) "N_$n" else n
}

val generateReadings by tasks.registering {
    val input = modelExport.file("readings.json")
    inputs.file(input)
    outputs.dir(generatedMain)
    doLast {
        @Suppress("UNCHECKED_CAST")
        val qs = JsonSlurper().parse(input.asFile) as List<Map<String, Any>>
        val out = StringBuilder()
        out.appendLine("// GENERATED from model/export/readings.json by :core:generateReadings. Do not edit.")
        out.appendLine("package pcs.core.readings")
        out.appendLine()
        out.appendLine("/** One reading of an open question (docs/concepts.md §1). */")
        out.appendLine("public interface ReadingValue { public val key: String; public val desc: String }")
        out.appendLine()
        for (q in qs) {
            val code = q["code"] as String
            @Suppress("UNCHECKED_CAST")
            val rs = q["readings"] as List<Map<String, String>>
            out.appendLine("/** $code: ${(q["text"] as String).replace("*/", "")} */")
            out.appendLine("public enum class $code(override val key: String, override val desc: String) : ReadingValue {")
            out.appendLine(rs.joinToString(",\n") { "    ${enumName(it["key"]!!)}(${kstr(it["key"]!!)}, ${kstr(it["desc"]!!)})" } + ";")
            out.appendLine("    public companion object { public fun ofKey(k: String): $code? = entries.firstOrNull { it.key == k } }")
            out.appendLine("}")
            out.appendLine()
        }
        out.appendLine("/** The open questions, in the model's order. */")
        out.appendLine("public enum class QId(public val code: String, public val text: String, public val readings: List<ReadingValue>) {")
        out.appendLine(qs.joinToString(",\n") { q ->
            val code = q["code"] as String
            "    ${code.uppercase()}(${kstr(code)}, ${kstr(q["text"] as String)}, pcs.core.readings.$code.entries.toList())"
        } + ";")
        out.appendLine("    public companion object { public fun ofCode(c: String): QId? = entries.firstOrNull { it.code == c } }")
        out.appendLine("}")
        out.appendLine()
        out.appendLine("/** A reading of the whole text: one answer per question, or null where the question is unresolved. */")
        out.appendLine("public data class Readings(")
        out.appendLine(qs.joinToString(",\n") { q -> val c = q["code"] as String; "    val ${c.lowercase()}: $c? = null" })
        out.appendLine(") {")
        out.appendLine("    public operator fun get(q: QId): ReadingValue? = when (q) {")
        for (q in qs) { val c = q["code"] as String; out.appendLine("        QId.${c.uppercase()} -> ${c.lowercase()}") }
        out.appendLine("    }")
        out.appendLine("    public fun with(q: QId, key: String): Readings? = when (q) {")
        for (q in qs) { val c = q["code"] as String; out.appendLine("        QId.${c.uppercase()} -> $c.ofKey(key)?.let { copy(${c.lowercase()} = it) }") }
        out.appendLine("    }")
        out.appendLine("    /** Unresolved questions take their first reading, as the model's `Answers.base` does. */")
        out.appendLine("    public fun base(): Readings = copy(")
        out.appendLine(qs.joinToString(",\n") { q -> val c = q["code"] as String; "        ${c.lowercase()} = ${c.lowercase()} ?: $c.entries.first()" })
        out.appendLine("    )")
        out.appendLine("}")
        val f = generatedMain.get().file("pcs/core/readings/Generated.kt").asFile
        f.parentFile.mkdirs()
        f.writeText(out.toString())
    }
}

sourceSets.main { kotlin.srcDir(generatedMain) }
tasks.named("compileKotlin") { dependsOn(generateReadings) }

// ---- Tests --------------------------------------------------------------------------

tasks.test {
    useJUnitPlatform { includeEngines("junit-jupiter", "jqwik") }
    systemProperty("pcs.repoRoot", rootProject.projectDir.absolutePath)
    systemProperty("pcs.coversDir", layout.buildDirectory.dir("covers").get().asFile.absolutePath)
    inputs.dir(modelExport)
}

// ---- Claim inventory (PLAN §A2) ---------------------------------------------------------

val claimsFile = layout.buildDirectory.file("claims/claims.json")

val claimsInventory by tasks.registering {
    val root = rootProject.layout.projectDirectory
    val sources = listOf("model/export/cards.json", "model/export/readings.json", "model/export/policy.json",
        "model/export/mutants.json", "docs/concepts.md", "docs/spec.md", "PLAN.md").map { root.file(it) }
    inputs.files(sources)
    outputs.file(claimsFile)
    doLast {
        val claims = mutableListOf<Map<String, String>>()
        fun add(id: String, kind: String, text: String) { claims += mapOf("id" to id, "kind" to kind, "text" to text) }
        val slurp = JsonSlurper()
        @Suppress("UNCHECKED_CAST")
        (slurp.parse(root.file("model/export/cards.json").asFile) as List<Map<String, Any>>)
            .forEach { add("card:${it["id"]}", "card", it["text"] as String) }
        @Suppress("UNCHECKED_CAST")
        (slurp.parse(root.file("model/export/readings.json").asFile) as List<Map<String, Any>>).forEach { q ->
            (q["readings"] as List<Map<String, String>>).forEach { add("q:${q["code"]}=${it["key"]}", "reading", it["desc"]!!) }
        }
        @Suppress("UNCHECKED_CAST")
        val policy = slurp.parse(root.file("model/export/policy.json").asFile) as Map<String, Any>
        @Suppress("UNCHECKED_CAST")
        val table = ((policy["byQ4"] as List<Map<String, Any>>).first()["cells"] as List<Map<String, Any>>)
        table.forEach { c ->
            @Suppress("UNCHECKED_CAST")
            val kind = (c["cell"] as Map<String, Any>)["kind"] as String
            add("cell:${c["role"]}/${c["perm"]}", "cell", kind)
        }
        @Suppress("UNCHECKED_CAST")
        (slurp.parse(root.file("model/export/mutants.json").asFile) as List<String>)
            .forEachIndexed { i, name -> add("mutant:$i", "mutant", name) }
        val concepts = root.file("docs/concepts.md").asFile.readText()
        val props = concepts.substringAfter("### 3.10 Properties").substringBefore("### 3.11")
        Regex("""(?m)^\| ([A-Z]+-?[0-9]+) ?◆? \| ([^|]+)\|""").findAll(props)
            .forEach { add("prop:${it.groupValues[1]}", "property", it.groupValues[2].trim()) }
        val rules = concepts.substringAfter("### 3.8 Rules").substringBefore("### 3.9")
        Regex("""(?m)^rule ([a-z-]+) \(""").findAll(rules).forEach { add("rule:${it.groupValues[1]}", "rule", "") }
        add("rule:owes", "rule", "derived in Nomination (concepts §3.3)")
        Regex("""(?m)^assume (A[0-9]+)\s+(.+)$""").findAll(concepts)
            .forEach { add("assume:${it.groupValues[1]}", "assumption", it.groupValues[2].trim()) }
        val spec = root.file("docs/spec.md").asFile.readText()
        val conv = spec.substringAfter("## 11. HotCRP conventions").substringAfter("|---|---|---|---|\n").substringBefore("\n\n")
        conv.lines().filter { it.startsWith("| ") }.forEachIndexed { i, row ->
            add("conv:${i + 1}", "convention", row.split("|")[1].trim())
        }
        val plan = root.file("PLAN.md").asFile.readText()
        val golden = plan.substringAfter("### Golden scenario").substringBefore("**Second assertion instant")
        Regex("""(?m)^\| ([0-9]+) \| ([^|]+)\|""").findAll(golden)
            .forEach { add("golden:pid${it.groupValues[1]}", "golden", it.groupValues[2].trim()) }
        val dup = claims.groupBy { it["id"] }.filter { it.value.size > 1 }.keys
        check(dup.isEmpty()) { "duplicate claim IDs: $dup" }
        val f = claimsFile.get().asFile
        f.parentFile.mkdirs()
        f.writeText(groovy.json.JsonOutput.prettyPrint(groovy.json.JsonOutput.toJson(claims)))
        logger.lifecycle("claims: ${claims.size} (" + claims.groupingBy { it["kind"] }.eachCount().entries.joinToString { "${it.key} ${it.value}" } + ")")
    }
}

tasks.test {
    dependsOn(claimsInventory)
    systemProperty("pcs.claimsFile", claimsFile.get().asFile.absolutePath)
}

tasks.test {
    val covers = layout.buildDirectory.dir("covers")
    doFirst { covers.get().asFile.deleteRecursively() }
}

// ---- Assurance report (PLAN §A7), first version: claim coverage by family -----------------

val assuranceReport by tasks.registering {
    dependsOn(claimsInventory)
    mustRunAfter(tasks.test)
    val coversFile = layout.buildDirectory.file("covers/covers.tsv")
    val out = rootProject.layout.buildDirectory.file("reports/assurance.md")
    outputs.file(out)
    outputs.upToDateWhen { false }
    doLast {
        @Suppress("UNCHECKED_CAST")
        val claims = JsonSlurper().parse(claimsFile.get().asFile) as List<Map<String, String>>
        val rows = coversFile.get().asFile.takeIf { it.exists() }?.readLines().orEmpty().map { it.split("\t") }
        // claim -> family -> outcomes
        val byClaim = rows.groupBy { it[1] }
        fun status(id: String): String {
            val rs = byClaim[id] ?: return "uncovered"
            return when {
                rs.any { it[2] == "fail" } -> "FAILING"
                rs.any { it[2] == "pass" } -> "covered (" + rs.filter { it[2] == "pass" }.map { it[0] }.distinct().sorted().joinToString("+") + ")"
                else -> "not implemented"
            }
        }
        val sb = StringBuilder()
        sb.appendLine("# Assurance report")
        sb.appendLine()
        sb.appendLine("Claims from the inventory (PLAN §A2) and the evidence the test run recorded for each. This first version counts claim coverage by family; transition, policy, mutation, and binding coverage arrive with M3a.")
        sb.appendLine()
        sb.appendLine("| Kind | Claims | Covered | Not implemented | Uncovered | Failing |")
        sb.appendLine("|---|---|---|---|---|---|")
        val kinds = claims.groupBy { it["kind"]!! }
        var failing = 0
        for ((kind, cs) in kinds.toSortedMap()) {
            val st = cs.map { status(it["id"]!!) }
            failing += st.count { it == "FAILING" }
            sb.appendLine("| $kind | ${cs.size} | ${st.count { it.startsWith("covered") }} | ${st.count { it == "not implemented" }} | ${st.count { it == "uncovered" }} | ${st.count { it == "FAILING" }} |")
        }
        sb.appendLine()
        sb.appendLine("## Claims with evidence")
        sb.appendLine()
        for (c in claims) {
            val s = status(c["id"]!!)
            if (s != "uncovered") sb.appendLine("- `${c["id"]}`: $s")
        }
        val f = out.get().asFile
        f.parentFile.mkdirs()
        f.writeText(sb.toString())
        logger.lifecycle("assurance report: ${f.relativeTo(rootProject.projectDir)}")
        check(failing == 0) { "$failing claims have failing evidence" }
    }
}
tasks.test { finalizedBy(assuranceReport) }

// ---- Integration tests against the harness (PLAN §A5 T11; never a real instance) -------------

testing {
    suites {
        register<JvmTestSuite>("integrationTest") {
            useJUnitJupiter(libs.versions.junit.get())
            dependencies {
                implementation(project())
                implementation(testFixtures(project()))
                implementation(libs.serialization.json)
                implementation(libs.coroutines.core)
            }
            targets.all {
                testTask.configure {
                    dependsOn(claimsInventory)
                    systemProperty("pcs.repoRoot", rootProject.projectDir.absolutePath)
                    systemProperty("pcs.claimsFile", claimsFile.get().asFile.absolutePath)
                    systemProperty("pcs.coversDir", layout.buildDirectory.dir("covers-integration").get().asFile.absolutePath)
                    listOf("PCS_HOTCRP_URL", "PCS_HOTCRP_TOKEN").forEach { k -> System.getenv(k)?.let { environment(k, it) } }
                    outputs.upToDateWhen { false }
                }
            }
        }
    }
}
