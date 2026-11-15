import groovy.json.JsonSlurper

// The scenario runner and its bindings (PLAN §A4-§A6): executes the model's exported traces against
// the harness and writes evidence records that `lake exe check-evidence` re-derives.
plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.kotlin.serialization)
}

kotlin {
    jvmToolchain(25)
    compilerOptions { allWarningsAsErrors.set(true) }
}

evaluationDependsOn(":core")

dependencies {
    api(project(":core"))
    implementation(libs.serialization.json)
    implementation(libs.coroutines.core)
    implementation(testFixtures(project(":core")))

    testImplementation(platform(libs.junit.bom))
    testImplementation(libs.junit.jupiter)
    testImplementation(testFixtures(project(":core")))
    testRuntimeOnly(libs.junit.launcher)
}

// ---- Code generation from the Lean model's export (PLAN §A4: "completeness is checked by the compiler") ----

val modelExport = rootProject.layout.projectDirectory.dir("model/export")
val generatedMain = layout.buildDirectory.dir("generated/model/main/kotlin")

fun pascal(s: String) = s.split(Regex("[^A-Za-z0-9]+")).filter { it.isNotEmpty() }.joinToString("") { it.replaceFirstChar(Char::uppercase) }

fun camel(s: String) = pascal(s).replaceFirstChar(Char::lowercase)

val generateActions by tasks.registering {
    val input = modelExport.file("actions.json")
    inputs.file(input)
    outputs.dir(generatedMain)
    doLast {
        @Suppress("UNCHECKED_CAST")
        val systems = JsonSlurper().parse(input.asFile) as List<Map<String, Any>>
        val out = StringBuilder()
        out.appendLine("// GENERATED from model/export/actions.json by :runner:generateActions. Do not edit.")
        out.appendLine("package net.jonbell.pcs.runner.model")
        out.appendLine()
        out.appendLine("/** An action of the Lean model; the bindings are exhaustive `when`s over these (PLAN §A4). */")
        out.appendLine("public sealed interface ModelAction {")
        out.appendLine("    public val subsystem: String")
        out.appendLine("    public val key: String")
        out.appendLine("    public val perm: String?")
        out.appendLine("    public val label: String")
        out.appendLine("}")
        out.appendLine()
        val parsers = StringBuilder()
        val obsOut = StringBuilder()
        for (sys in systems) {
            val name = sys["subsystem"] as String
            val p = pascal(name)

            @Suppress("UNCHECKED_CAST")
            val actions = sys["actions"] as List<Map<String, Any?>>
            out.appendLine("public sealed interface ${p}Action : ModelAction { override val subsystem: String get() = ${"\"" + name + "\""} }")
            out.appendLine()
            val byKey = actions.groupBy { it["key"] as String }
            parsers.appendLine("    public fun parse$p(key: String, args: Map<String, kotlinx.serialization.json.JsonElement>, label: String): ${p}Action =")
            parsers.appendLine("        when (key) {")
            for ((key, insts) in byKey) {
                val cls = p + pascal(key)

                @Suppress("UNCHECKED_CAST")
                val argNames = (insts.first()["args"] as Map<String, Any?>).keys.toList()
                val perm = insts.first()["perm"]?.let { "\"$it\"" } ?: "null"

                fun typeOf(a: String): String {
                    val vs = insts.map { (it["args"] as Map<*, *>)[a] }
                    val base =
                        when (vs.firstOrNull { it != null }) {
                            is Boolean -> "Boolean"
                            is Number -> "Long"
                            else -> "String"
                        }
                    return if (vs.any { it == null }) "$base?" else base
                }
                if (argNames.isEmpty()) {
                    out.appendLine("public data class $cls(override val label: String) : ${p}Action {")
                } else {
                    out.appendLine(
                        "public data class $cls(" + argNames.joinToString("") { "val ${camel(it)}: ${typeOf(it)}, " } +
                            "override val label: String) : ${p}Action {",
                    )
                }
                out.appendLine("    override val key: String get() = \"$key\"")
                out.appendLine("    override val perm: String? get() = $perm")
                out.appendLine("}")
                out.appendLine()
                val ctor =
                    argNames.joinToString("") { a ->
                        val t = typeOf(a)
                        val nn = t.endsWith("?")
                        val prim = "(args.getValue(\"$a\") as kotlinx.serialization.json.JsonPrimitive)"
                        val raw =
                            when (t.removeSuffix("?")) {
                                "Boolean" -> "$prim.content.toBoolean()"
                                "Long" -> "$prim.content.toLong()"
                                else -> "$prim.content"
                            }
                        val nullable = if (nn) "if (args.getValue(\"$a\") is kotlinx.serialization.json.JsonNull) null else $raw" else raw
                        "$nullable, "
                    }
                parsers.appendLine("            \"$key\" -> $cls($ctor label)")
            }
            parsers.appendLine("            else -> error(\"unknown $name action \$key\")")
            parsers.appendLine("        }")
            parsers.appendLine()

            @Suppress("UNCHECKED_CAST")
            val obs = (sys["observations"] as List<Map<String, Any>>)
            if (obs.isNotEmpty()) {
                val readers = obs.flatMap { (it["readers"] as List<*>).map { r -> r as String } }.distinct()
                for (r in readers) {
                    val mine = obs.filter { r in (it["readers"] as List<*>) }
                    obsOut.appendLine("/** The observations of $name that the $r reader must produce. */")
                    obsOut.appendLine("public enum class $p${pascal(r)}Obs(public val key: String) {")
                    obsOut.appendLine(mine.joinToString(",\n") { "    ${(it["key"] as String).uppercase().replace('-', '_')}(\"${it["key"]}\")" } + ";")
                    obsOut.appendLine("}")
                    obsOut.appendLine()
                }
                obsOut.appendLine("/** Every observation of $name, with the readers that must each produce it. */")
                obsOut.appendLine("public val ${camel(name)}Observations: List<Pair<String, List<String>>> = listOf(")
                obsOut.appendLine(
                    obs.joinToString(",\n") {
                        "    \"${it["key"]}\" to listOf(" +
                            (it["readers"] as List<*>).joinToString { r ->
                                "\"$r\""
                            } + ")"
                    },
                )
                obsOut.appendLine(")")
                obsOut.appendLine()
            }
        }
        out.appendLine("public object ModelActions {")
        out.append(parsers)
        out.appendLine(
            "    public fun parse(subsystem: String, key: String, args: Map<String, kotlinx.serialization.json.JsonElement>, label: String): ModelAction =",
        )
        out.appendLine("        when (subsystem) {")
        for (sys in systems) {
            val name = sys["subsystem"] as String
            out.appendLine("            \"$name\" -> parse${pascal(name)}(key, args, label)")
        }
        out.appendLine("            else -> error(\"unknown subsystem \$subsystem\")")
        out.appendLine("        }")
        out.appendLine("}")
        out.appendLine()
        out.append(obsOut)
        val f = generatedMain.get().file("net/jonbell/pcs/runner/model/Generated.kt").asFile
        f.parentFile.mkdirs()
        f.writeText(out.toString())
    }
}

sourceSets.main { kotlin.srcDir(generatedMain) }
tasks.named("compileKotlin") { dependsOn(generateActions) }
tasks.matching { it.name.startsWith("runKtlint") }.configureEach { dependsOn(generateActions) }

// ---- Tests -----------------------------------------------------------------------------

tasks.withType<Test>().configureEach { jvmArgs("--enable-native-access=ALL-UNNAMED") }

val claimsInventory = project(":core").tasks.named("claimsInventory")
val claimsFile = project(":core").layout.buildDirectory.file("claims/claims.json")
val evidenceDir = layout.buildDirectory.dir("evidence")

tasks.test {
    useJUnitPlatform()
    dependsOn(claimsInventory)
    systemProperty("pcs.repoRoot", rootProject.projectDir.absolutePath)
    systemProperty("pcs.claimsFile", claimsFile.get().asFile.absolutePath)
    systemProperty("pcs.coversDir", layout.buildDirectory.dir("covers").get().asFile.absolutePath)
}

testing {
    suites {
        register<JvmTestSuite>("integrationTest") {
            useJUnitJupiter(libs.versions.junit.get())
            dependencies {
                implementation(project())
                implementation(project(":core"))
                implementation(project(":seed")) // the early-reject scenario is seeded from within the test, after the suites that assert golden
                implementation(testFixtures(project(":core")))
                implementation(libs.serialization.json)
                implementation(libs.coroutines.core)
            }
            targets.all {
                testTask.configure {
                    val coversInt = layout.buildDirectory.dir("covers-integration")
                    doFirst {
                        coversInt.get().asFile.deleteRecursively()
                        evidenceDir.get().asFile.deleteRecursively()
                    }
                    // The runner adds papers to the harness, so it runs after the suites that assert golden.
                    mustRunAfter(":core:integrationTest", ":seed:integrationTest")
                    finalizedBy(project(":core").tasks.named("assuranceReport"))
                    dependsOn(claimsInventory)
                    jvmArgs("--enable-native-access=ALL-UNNAMED")
                    systemProperty("pcs.repoRoot", rootProject.projectDir.absolutePath)
                    systemProperty("pcs.claimsFile", claimsFile.get().asFile.absolutePath)
                    systemProperty("pcs.coversDir", coversInt.get().asFile.absolutePath)
                    systemProperty("pcs.evidenceDir", evidenceDir.get().asFile.absolutePath)
                    listOf("PCS_HOTCRP_URL", "PCS_HOTCRP_TOKEN", "HOTCRP_COMPOSE_PROJECT").forEach { k -> System.getenv(k)?.let { environment(k, it) } }
                    outputs.upToDateWhen { false }
                }
            }
        }
    }
}

// ---- T9, the scale scenario (PLAN M19): sync, re-sync, solve and table loads on the 4,000-paper harness; nightly only.
// `./gradlew scaleTest` (root) runs this, then :app:scaleUiTest, then writes the summary and re-derives the verdicts.
val scaleDir = rootProject.layout.buildDirectory.dir("scale")

testing {
    suites {
        register<JvmTestSuite>("scaleTest") {
            useJUnitJupiter(libs.versions.junit.get())
            dependencies {
                implementation(project())
                implementation(project(":core"))
                implementation(project(":seed"))
                implementation(testFixtures(project(":core")))
                implementation(libs.serialization.json)
                implementation(libs.coroutines.core)
            }
            targets.all {
                testTask.configure {
                    dependsOn(claimsInventory)
                    // the 4,000-paper analyses need more than the default heap
                    maxHeapSize = "4g"
                    jvmArgs("--enable-native-access=ALL-UNNAMED")
                    systemProperty("pcs.repoRoot", rootProject.projectDir.absolutePath)
                    systemProperty("pcs.claimsFile", claimsFile.get().asFile.absolutePath)
                    systemProperty("pcs.coversDir", layout.buildDirectory.dir("covers-scale").get().asFile.absolutePath)
                    systemProperty("pcs.scaleDir", scaleDir.get().asFile.absolutePath)
                    listOf("PCS_HOTCRP_URL", "PCS_HOTCRP_TOKEN", "HOTCRP_COMPOSE_PROJECT", "PCS_SCALE_RUNS").forEach { k ->
                        System.getenv(k)?.let { environment(k, it) }
                    }
                    outputs.upToDateWhen { false }
                    testLogging { showStandardStreams = true }
                    doFirst { if (System.getenv("PCS_SCALE_KEEP") == null) scaleDir.get().asFile.deleteRecursively() }
                }
            }
        }
    }
}

// ---- Re-derive every verdict from the evidence records (PLAN §A6); CI runs this after the integration tests ----
tasks.register<Exec>("checkEvidence") {
    description = "Runs `lake exe check-evidence` on the evidence records the integration tests wrote."
    workingDir = rootProject.layout.projectDirectory.dir("model").asFile
    commandLine("lake", "exe", "check-evidence", evidenceDir.get().asFile.absolutePath)
}
