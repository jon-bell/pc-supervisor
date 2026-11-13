plugins {
    alias(libs.plugins.kotlin.jvm)
    application
}

kotlin {
    jvmToolchain(25)
    compilerOptions { allWarningsAsErrors.set(true) }
}

dependencies {
    implementation(libs.serialization.json)
}

application {
    mainClass.set("pcs.seed.MainKt")
}

tasks.named<JavaExec>("run") {
    workingDir = rootProject.projectDir
}

testing {
    suites {
        register<JvmTestSuite>("integrationTest") {
            useJUnitJupiter(libs.versions.junit.get())
            dependencies {
                implementation(project())
                implementation(project(":core"))
                implementation(testFixtures(project(":core")))
                implementation(libs.serialization.json)
                implementation(libs.coroutines.core)
            }
            targets.all {
                testTask.configure {
                    dependsOn(":core:claimsInventory")
                    systemProperty("pcs.repoRoot", rootProject.projectDir.absolutePath)
                    systemProperty("pcs.claimsFile", project(":core").layout.buildDirectory.file("claims/claims.json").get().asFile.absolutePath)
                    systemProperty("pcs.coversDir", project(":core").layout.buildDirectory.dir("covers-integration").get().asFile.absolutePath)
                    listOf("PCS_HOTCRP_URL", "PCS_HOTCRP_TOKEN").forEach { k -> System.getenv(k)?.let { environment(k, it) } }
                    outputs.upToDateWhen { false }
                }
            }
        }
    }
}
