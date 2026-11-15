plugins {
    alias(libs.plugins.kotlin.jvm)
    application
}

kotlin {
    jvmToolchain(25)
    compilerOptions { allWarningsAsErrors.set(true) }
}

dependencies {
    implementation(project(":core"))
    implementation(project(":agent"))
    implementation(libs.coroutines.core)
    implementation(libs.serialization.json)
    runtimeOnly(libs.slf4j.nop)

    testImplementation(testFixtures(project(":core")))
    testImplementation(platform(libs.junit.bom))
    testImplementation(libs.junit.jupiter)
    testRuntimeOnly(libs.junit.launcher)
}

application {
    mainClass.set("net.jonbell.pcs.cli.MainKt")
    applicationName = "pcs"
}

val coreBuild = project(":core").layout.buildDirectory

// The federated evaluation kit's tests (PLAN M21). Unit tests use synthetic exports, the deterministic checks and the replay engine; no test
// calls a model or a network.
tasks.test {
    useJUnitPlatform()
    dependsOn(":core:claimsInventory")
    maxHeapSize = "2g"
    systemProperty("pcs.repoRoot", rootProject.projectDir.absolutePath)
    systemProperty("pcs.noLive", "true")
    systemProperty("pcs.claimsFile", coreBuild.file("claims/claims.json").get().asFile.absolutePath)
    systemProperty("pcs.coversDir", layout.buildDirectory.dir("covers").get().asFile.absolutePath)
    val covers = layout.buildDirectory.dir("covers")
    doFirst { covers.get().asFile.deleteRecursively() }
    finalizedBy(":core:assuranceReport")
}

// Run on a harness seeded with `golden` (after the seed, core, runner and agent suites): the kit reads the seeded conference with a token.
testing {
    suites {
        register<JvmTestSuite>("integrationTest") {
            useJUnitJupiter(libs.versions.junit.get())
            dependencies {
                implementation(project())
                implementation(project(":core"))
                implementation(project(":agent"))
                implementation(testFixtures(project(":core")))
                implementation(libs.serialization.json)
                implementation(libs.coroutines.core)
                implementation(sourceSets.test.get().output)
            }
            targets.all {
                testTask.configure {
                    val coversInt = layout.buildDirectory.dir("covers-integration")
                    doFirst { coversInt.get().asFile.deleteRecursively() }
                    finalizedBy(":core:assuranceReport")
                    dependsOn(":core:claimsInventory")
                    mustRunAfter(":seed:integrationTest", ":core:integrationTest", ":runner:integrationTest", ":agent:integrationTest")
                    maxHeapSize = "2g"
                    systemProperty("pcs.repoRoot", rootProject.projectDir.absolutePath)
                    systemProperty("pcs.noLive", "true")
                    systemProperty("pcs.claimsFile", coreBuild.file("claims/claims.json").get().asFile.absolutePath)
                    systemProperty("pcs.coversDir", coversInt.get().asFile.absolutePath)
                    listOf("PCS_HOTCRP_URL", "PCS_HOTCRP_TOKEN").forEach { k -> System.getenv(k)?.let { environment(k, it) } }
                    outputs.upToDateWhen { false }
                }
            }
        }
    }
}

// One jar with every dependency, for scripts/package-pcs-linux.sh (jpackage on a single-entry classpath; see that script for why).
val pcsUberJar by tasks.registering(Jar::class) {
    archiveClassifier.set("all")
    duplicatesStrategy = DuplicatesStrategy.EXCLUDE
    manifest { attributes("Main-Class" to "net.jonbell.pcs.cli.MainKt") }
    from(sourceSets.main.get().output)
    from(configurations.runtimeClasspath.map { cp -> cp.map { if (it.isDirectory) it else zipTree(it) } })
    exclude("META-INF/*.SF", "META-INF/*.RSA", "META-INF/*.DSA", "module-info.class")
}
