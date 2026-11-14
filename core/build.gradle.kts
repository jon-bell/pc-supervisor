import groovy.json.JsonSlurper

plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.kotlin.serialization)
    `java-test-fixtures`
}

kotlin {
    jvmToolchain(25)
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
    testImplementation(libs.jna)
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
        out.appendLine(
            qs.joinToString(",\n") { q ->
                val code = q["code"] as String
                "    ${code.uppercase()}(${kstr(code)}, ${kstr(q["text"] as String)}, pcs.core.readings.$code.entries.toList())"
            } + ";",
        )
        out.appendLine("    public companion object { public fun ofCode(c: String): QId? = entries.firstOrNull { it.code == c } }")
        out.appendLine("}")
        out.appendLine()
        out.appendLine("/** A reading of the whole text: one answer per question, or null where the question is unresolved. */")
        out.appendLine("public data class Readings(")
        out.appendLine(
            qs.joinToString(",\n") { q ->
                val c = q["code"] as String
                "    val ${c.lowercase()}: $c? = null"
            },
        )
        out.appendLine(") {")
        out.appendLine("    public operator fun get(q: QId): ReadingValue? = when (q) {")
        for (q in qs) {
            val c = q["code"] as String
            out.appendLine("        QId.${c.uppercase()} -> ${c.lowercase()}")
        }
        out.appendLine("    }")
        out.appendLine("    public fun with(q: QId, key: String): Readings? = when (q) {")
        for (q in qs) {
            val c = q["code"] as String
            out.appendLine("        QId.${c.uppercase()} -> $c.ofKey(key)?.let { copy(${c.lowercase()} = it) }")
        }
        out.appendLine("    }")
        out.appendLine("    /** Unresolved questions take their first reading, as the model's `Answers.base` does. */")
        out.appendLine("    public fun base(): Readings = copy(")
        out.appendLine(
            qs.joinToString(",\n") { q ->
                val c = q["code"] as String
                "        ${c.lowercase()} = ${c.lowercase()} ?: $c.entries.first()"
            },
        )
        out.appendLine("    )")
        out.appendLine("}")
        val f = generatedMain.get().file("pcs/core/readings/Generated.kt").asFile
        f.parentFile.mkdirs()
        f.writeText(out.toString())
    }
}

sourceSets.main { kotlin.srcDir(generatedMain) }
tasks.named("compileKotlin") { dependsOn(generateReadings) }

// The example cards and the policy table ship with core: the app's card gallery and the settings
// screen's "what it blocks" read them (PLAN M4).
tasks.named<ProcessResources>("processResources") {
    from(modelExport) {
        include("cards.json", "policy.json")
        into("pcs/model")
    }
}

// ---- Tests --------------------------------------------------------------------------

// JNA loads the Lean-in-core library; JDK 25 warns unless native access is granted
tasks.withType<Test>().configureEach { jvmArgs("--enable-native-access=ALL-UNNAMED") }

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
    val sources =
        listOf(
            "model/export/cards.json",
            "model/export/readings.json",
            "model/export/policy.json",
            "model/export/mutants.json",
            "docs/concepts.md",
            "docs/spec.md",
            "docs/agent.md",
            "PLAN.md",
        ).map { root.file(it) }
    inputs.files(sources)
    outputs.file(claimsFile)
    doLast {
        val claims = mutableListOf<Map<String, String>>()

        fun add(id: String, kind: String, text: String) {
            claims += mapOf("id" to id, "kind" to kind, "text" to text)
        }
        val slurp = JsonSlurper()
        @Suppress("UNCHECKED_CAST")
        (slurp.parse(root.file("model/export/cards.json").asFile) as List<Map<String, Any>>)
            .forEach {
                add("card:${it["id"]}", "card", it["text"] as String)
                // T12: the card gallery renders every card (PLAN M4)
                add("view:card-${it["id"]}", "view", "the card gallery shows card ${it["id"]}")
            }
        // T12: one claim per screen of the app; a milestone that adds a screen adds its claim here
        mapOf(
            "unlock" to "the keychain unlock screen",
            "picker" to "the conference picker",
            "papers" to "the paper table",
            "reviews" to "the review table",
            "settings" to "the settings screen: readings, unresolved questions, what they block",
            "early-reject" to "the early-reject screen: candidates, bump status, AC objections, the mail search, the decision artifact",
            "writeback" to "the Writeback review screen: HotCRP's dry-run diff and the confirmation (PLAN M5)",
            "report" to "the sync report: Writeback mismatches and traces that don't parse or were forged (PLAN M5)",
        ).forEach { (k, v) -> add("view:$k", "view", v) }
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
        // One claim per screening check in the catalog (agent.md §3.2): `check:format`, `check:injection.hidden`, ...
        val catalog = root.file("docs/agent.md").asFile.readText().substringAfter("### 3.2 Check catalog").substringBefore("### 3.3")
        Regex("""(?m)^\| `([a-z.]+)` \| ([^|]+)\|""").findAll(catalog)
            .forEach { add("check:${it.groupValues[1]}", "check", it.groupValues[2].trim()) }
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
    mustRunAfter(tasks.test, tasks.named("integrationTest"), ":agent:test")
    val coversFiles =
        listOf("covers", "covers-integration", "covers-agent").map { layout.buildDirectory.file("$it/covers.tsv") } +
            listOf("covers", "covers-ui").map { project(":app").layout.buildDirectory.file("$it/covers.tsv") } +
            listOf("covers", "covers-integration").map { project(":runner").layout.buildDirectory.file("$it/covers.tsv") }
    val evidenceTraces = project(":runner").layout.buildDirectory.dir("evidence/traces")
    val transitionsFile = rootProject.layout.projectDirectory.file("model/export/transitions-desk.json")
    val policyFile = rootProject.layout.projectDirectory.file("model/export/policy.json")
    val out = rootProject.layout.buildDirectory.file("reports/assurance.md")
    outputs.file(out)
    outputs.upToDateWhen { false }
    doLast {
        @Suppress("UNCHECKED_CAST")
        val claims = JsonSlurper().parse(claimsFile.get().asFile) as List<Map<String, String>>
        val rows = coversFiles.flatMap { f -> f.get().asFile.takeIf { it.exists() }?.readLines().orEmpty() }.map { it.split("\t") }
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
        sb.appendLine(
            "Claims from the inventory (PLAN §A2) and the evidence the test run recorded for each. It lists the test families that covered each kind of claim, then policy and transition coverage. Mutation and residual-risk columns arrive later.",
        )
        sb.appendLine()
        sb.appendLine("| Kind | Claims | Covered | Not implemented | Uncovered | Failing | Families |")
        sb.appendLine("|---|---|---|---|---|---|---|")
        val kinds = claims.groupBy { it["kind"]!! }
        var failing = 0
        for ((kind, cs) in kinds.toSortedMap()) {
            val st = cs.map { status(it["id"]!!) }
            failing += st.count { it == "FAILING" }
            sb.appendLine(
                "| $kind | ${cs.size} | ${st.count {
                    it.startsWith("covered")
                }} | ${st.count { it == "not implemented" }} | ${st.count { it == "uncovered" }} | ${st.count { it == "FAILING" }} | ${
                    cs.flatMap { c ->
                        (byClaim[c["id"]!!] ?: emptyList()).filter { it[2] == "pass" }.map { it[0] }
                    }.distinct().sorted().joinToString(" ").ifEmpty { "-" }
                } |",
            )
        }
        sb.appendLine()

        // ---- policy coverage (PLAN §A7): granted cells on modeled actions need T5, denied ones T6 ----
        @Suppress("UNCHECKED_CAST")
        val policy = JsonSlurper().parse(policyFile.asFile) as Map<String, Any>

        @Suppress("UNCHECKED_CAST")
        val modeled = (policy["modeledPerms"] as List<String>).toSet()

        @Suppress("UNCHECKED_CAST")
        val cells = ((policy["byQ4"] as List<Map<String, Any>>).first()["cells"] as List<Map<String, Any>>).filter { it["perm"] in modeled }

        fun cellKind(c: Map<String, Any>) = (c["cell"] as Map<*, *>)["kind"] as String

        fun families(c: Map<String, Any>) = (byClaim["cell:${c["role"]}/${c["perm"]}"] ?: emptyList()).filter { it[2] == "pass" }.map { it[0] }.toSet()
        val granted = cells.filter { cellKind(it) == "granted" }
        val denied = cells.filter { cellKind(it) == "denied" }
        sb.appendLine("## Policy coverage")
        sb.appendLine()
        sb.appendLine("Cells on modeled actions (PLAN §A7). Visibility cells, with no modeled action, are enforced by T7 and not counted here.")
        sb.appendLine()
        sb.appendLine("| Cells | Count | Covered | Family required |")
        sb.appendLine("|---|---|---|---|")
        sb.appendLine("| granted | ${granted.size} | ${granted.count { "T5" in families(it) }} | T5 |")
        sb.appendLine("| denied | ${denied.size} | ${denied.count { "T6" in families(it) }} | T6 |")
        sb.appendLine()

        // ---- transition coverage (PLAN §A7): the model's desk-reject transitions that an evidence record takes ----
        sb.appendLine("## Transition coverage")
        sb.appendLine()
        if (!transitionsFile.asFile.exists() || !evidenceTraces.get().asFile.exists()) {
            sb.appendLine("No evidence records in this run (run the integration tests against the harness).")
        } else {
            @Suppress("UNCHECKED_CAST")
            val tr = JsonSlurper().parse(transitionsFile.asFile) as Map<String, Any>

            @Suppress("UNCHECKED_CAST")
            val readings = tr["readings"] as List<Map<String, Any>>
            val records =
                evidenceTraces.get().asFile.listFiles { f -> f.extension == "json" }.orEmpty().map { JsonSlurper().parse(it) as Map<String, Any?> }
                    .filter { it["bindingMutant"] == null && it["implementationFault"] == null }

            fun key(obs: Map<String, Any?>) = obs.toSortedMap().entries.joinToString("|") { "${it.key}=${groovy.json.JsonOutput.toJson(it.value)}" }

            fun move(step: Map<String, Any?>): String {
                @Suppress("UNCHECKED_CAST")
                val a = step["action"] as Map<String, Any?>

                @Suppress("UNCHECKED_CAST")
                val ps = (a["params"] as Map<String, Any?>).toSortedMap().entries.joinToString(",") { "${it.key}=${it.value ?: "null"}" }
                return "${step["role"] ?: "env"}|${a["key"]}|$ps"
            }
            sb.appendLine("| Subsystem | Reading | Transitions | Taken by evidence | Share |")
            sb.appendLine("|---|---|---|---|---|")
            for (rd in readings) {
                val tag = rd["reading"] as String

                @Suppress("UNCHECKED_CAST")
                val states = rd["states"] as List<String>

                @Suppress("UNCHECKED_CAST")
                val all =
                    (rd["transitions"] as List<List<Any>>).map {
                        "${states[(it[0] as Number).toInt()]}>>${it[1]}>>${states[(it[2] as Number).toInt()]}"
                    }.toSet()
                val taken = mutableSetOf<String>()
                for (r in records) {
                    @Suppress("UNCHECKED_CAST")
                    val q1 = (r["reading"] as Map<String, String>)["Q1"]
                    if ((if (q1 == "fix-window") "fix-window" else "signed") != tag) continue
                    var from = rd["initial"] as String

                    @Suppress("UNCHECKED_CAST")
                    for (st in r["steps"] as List<Map<String, Any?>>) {
                        @Suppress("UNCHECKED_CAST")
                        val obs = (st["observed"] as Map<String, Map<String, Any?>>).mapValues { it.value.values.first() }
                        val to = key(obs)
                        if (st["outcome"] == "effective") taken += "$from>>${move(st)}>>$to"
                        from = to
                    }
                }
                val hit = taken.count { it in all }
                sb.appendLine("| desk reject | $tag | ${all.size} | $hit | ${"%.1f".format(100.0 * hit / all.size)}% |")
            }
            sb.appendLine()
            sb.appendLine("Only witness traces run in M3a. Bounded-exhaustive traces (every transition of each subsystem below 10^4 states) arrive with T3.")
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
                implementation(project(":seed")) // the nomination scenario (PLAN M7)
                implementation(libs.serialization.json)
                implementation(libs.coroutines.core)
            }
            targets.all {
                testTask.configure {
                    val coversInt = layout.buildDirectory.dir("covers-integration")
                    doFirst { coversInt.get().asFile.deleteRecursively() }
                    finalizedBy(assuranceReport)
                    mustRunAfter(":seed:integrationTest") // MirrorTest changes the seeded harness
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

// ktlint reads the main source set, which includes the generated readings.
tasks.matching { it.name.startsWith("runKtlint") }.configureEach { dependsOn(generateReadings) }
