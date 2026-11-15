import java.security.MessageDigest

plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.kotlin.serialization)
}

kotlin {
    jvmToolchain(25)
    compilerOptions { allWarningsAsErrors.set(true) }
}

dependencies {
    implementation(project(":core"))
    implementation(libs.serialization.json)
    // PDF text, layout, rendering, and channels (agent.md §8 extract/). Apache-2.0.
    implementation(libs.pdfbox)
    // check.yaml (agent.md §3.2). Apache-2.0, no transitive dependencies.
    implementation(libs.snakeyaml.engine)
    // Engine layer (agent.md §4): the coroutine API, Ktor for openai-compat, and Anthropic's official Java SDK
    // (first-party API plus the Bedrock, Vertex, and Foundry backends, which are configuration only here).
    implementation(libs.coroutines.core)
    implementation(libs.ktor.client.core)
    implementation(libs.ktor.client.cio)
    implementation(libs.anthropic.java)
    implementation(libs.anthropic.bedrock)
    implementation(libs.anthropic.vertex)
    implementation(libs.anthropic.foundry)

    testImplementation(testFixtures(project(":core")))
    testImplementation(libs.ktor.client.mock)
    testImplementation(platform(libs.junit.bom))
    testImplementation(libs.junit.jupiter)
    testRuntimeOnly(libs.junit.launcher)
}

// ---- Check directories (agent.md §3.2): packaged as resources, versioned by content ----------

val checksDir = layout.projectDirectory.dir("checks")
val generatedResources = layout.buildDirectory.dir("generated/checks/resources")

/**
 * A check's version is a content hash of its directory plus the code files its check.yaml lists
 * under `code:`, so editing the spec, the schema, the oracle, or the code is a new version.
 */
val checkVersions by tasks.registering {
    inputs.dir(checksDir)
    inputs.dir(layout.projectDirectory.dir("src/main/kotlin"))
    outputs.dir(generatedResources)
    doLast {
        val root = checksDir.asFile
        val lines = mutableListOf<String>()
        root.listFiles()!!.filter { it.isDirectory }.sortedBy { it.name }.forEach { dir ->
            val md = MessageDigest.getInstance("SHA-256")
            dir.walkTopDown().filter { it.isFile }.sortedBy { it.relativeTo(dir).invariantSeparatorsPath }.forEach { f ->
                md.update(f.relativeTo(dir).invariantSeparatorsPath.toByteArray())
                md.update(0)
                md.update(f.readBytes())
                md.update(0)
            }
            val yaml = dir.resolve("check.yaml").readText()
            val code =
                yaml.substringAfter("\ncode:", "").lineSequence().drop(1)
                    .takeWhile { it.startsWith("  - ") }.map { it.removePrefix("  - ").trim() }.toList()
            code.sorted().forEach { rel ->
                val f = layout.projectDirectory.file(rel).asFile
                check(f.isFile) { "${dir.name}/check.yaml lists code file $rel, which does not exist" }
                md.update(rel.toByteArray())
                md.update(0)
                md.update(f.readBytes())
                md.update(0)
            }
            val hex = md.digest().joinToString("") { "%02x".format(it) }
            lines += "${dir.name}=${hex.take(12)}"
        }
        val out = generatedResources.get().file("net/jonbell/pcs/agent/check-versions.properties").asFile
        out.parentFile.mkdirs()
        out.writeText(lines.joinToString("\n", postfix = "\n"))
    }
}

sourceSets.main {
    resources.srcDir(generatedResources)
}
tasks.processResources {
    dependsOn(checkVersions)
    from(checksDir) { into("net/jonbell/pcs/agent/checks") }
}

// ---- Tests -------------------------------------------------------------------------------

val coreBuild = project(":core").layout.buildDirectory

tasks.test {
    useJUnitPlatform()
    dependsOn(":core:claimsInventory")
    maxHeapSize = "2g"
    systemProperty("pcs.repoRoot", rootProject.projectDir.absolutePath)
    // Tests never reach a live engine: the claude-code adapter refuses to start the real CLI (LiveGuard).
    systemProperty("pcs.noLive", "true")
    systemProperty("pcs.claimsFile", coreBuild.file("claims/claims.json").get().asFile.absolutePath)
    systemProperty("pcs.coversDir", coreBuild.dir("covers-agent").get().asFile.absolutePath)
    systemProperty("pcs.corpusDir", layout.buildDirectory.dir("synthetic").get().asFile.absolutePath)
    systemProperty("pcs.reportsDir", layout.buildDirectory.dir("reports/screening").get().asFile.absolutePath)
    // Opt-in: the OCR container (agent/ocr/Dockerfile) and a local GROBID. Never in `check`.
    listOf("PCS_AGENT_OCR_IMAGE", "PCS_AGENT_GROBID_URL", "PCS_TEST_OCR_DOCKER").forEach { k -> System.getenv(k)?.let { environment(k, it) } }
    val covers = coreBuild.dir("covers-agent")
    doFirst { covers.get().asFile.deleteRecursively() }
    finalizedBy(":core:assuranceReport")
}

// The synthetic corpus as files, for looking at by hand (tests generate their own copy).
val syntheticCorpus by tasks.registering(JavaExec::class) {
    classpath = sourceSets.main.get().runtimeClasspath
    mainClass.set("net.jonbell.pcs.agent.eval.CorpusKt")
    args(layout.buildDirectory.dir("synthetic").get().asFile.absolutePath)
}

// Per-check mutation score and false-flag rate on the corpus (agent.md §7.2); also asserted by the tests.
val screeningScore by tasks.registering(JavaExec::class) {
    classpath = sourceSets.main.get().runtimeClasspath
    mainClass.set("net.jonbell.pcs.agent.eval.ScoreKt")
    args(layout.buildDirectory.dir("reports/screening").get().asFile.absolutePath)
}

// Records the fixed sample of live calls (synthetic papers only) through the claude-code adapter into
// agent/fixtures/replay. By hand, never in `check`: PCS_LIVE_OK=1 ./gradlew :agent:liveSample -Pcap=<n> [-Pcase=<id>]
val liveSample by tasks.registering(JavaExec::class) {
    classpath = sourceSets.main.get().runtimeClasspath
    mainClass.set("net.jonbell.pcs.agent.llm.LiveSample")
    workingDir = layout.projectDirectory.asFile
    args(layout.projectDirectory.asFile.absolutePath, (findProperty("cap") ?: "0").toString())
    findProperty("case")?.let { args(it.toString()) }
    environment("PCS_LIVE_OK", System.getenv("PCS_LIVE_OK") ?: "")
}
