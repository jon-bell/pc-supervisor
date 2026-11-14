import org.jetbrains.compose.desktop.application.dsl.TargetFormat

plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.compose.multiplatform)
}

kotlin {
    jvmToolchain(25)
    compilerOptions { allWarningsAsErrors.set(true) }
}

dependencies {
    implementation(project(":core"))
    implementation(compose.desktop.currentOs)
    implementation(compose.material3)
    implementation(libs.coroutines.core)
    runtimeOnly(libs.slf4j.nop)

    testImplementation(platform(libs.junit.bom))
    testImplementation(libs.junit.jupiter)
    testImplementation(testFixtures(project(":core")))
    testRuntimeOnly(libs.junit.launcher)
    @OptIn(org.jetbrains.compose.ExperimentalComposeLibrary::class)
    testImplementation(compose.uiTest)
    testImplementation(libs.roborazzi.compose.desktop)
}

val appVersion = "0.4.0"

evaluationDependsOn(":core")

val claimsInventory = project(":core").tasks.named("claimsInventory")
val claimsFile = project(":core").layout.buildDirectory.file("claims/claims.json")
val screenshotDir = layout.buildDirectory.dir("screenshots")

// Plain unit tests (table logic, view reader); the Compose UI tests are tagged "ui" and run in uiTest.
tasks.test {
    useJUnitPlatform { excludeTags("ui") }
    configureUiTestCommon()
}

// Compose UI tests: the ones that need nothing but the app's own resources, and the ones against the
// harness's synced `golden` (tagged "harness"; they need PCS_HOTCRP_URL and PCS_HOTCRP_TOKEN, and
// refuse to run against anything but localhost). CI: `xvfb-run -a ./gradlew uiTest` with .env.test loaded.
val uiTest by tasks.registering(Test::class) {
    description = "Compose UI tests; writes screenshots to app/build/screenshots"
    group = "verification"
    testClassesDirs = sourceSets.test.get().output.classesDirs
    classpath = sourceSets.test.get().runtimeClasspath
    useJUnitPlatform { includeTags("ui") }
    configureUiTestCommon()
    doFirst { screenshotDir.get().asFile.deleteRecursively() }
    listOf("PCS_HOTCRP_URL", "PCS_HOTCRP_TOKEN").forEach { k -> System.getenv(k)?.let { environment(k, it) } }
    outputs.upToDateWhen { false }
    // the process never touches the user's keychain or conference directory
    environment("PCS_CONFERENCES", layout.buildDirectory.dir("ui-conferences").get().asFile.absolutePath)
}

fun Test.configureUiTestCommon() {
    dependsOn(claimsInventory)
    jvmArgs("--enable-native-access=ALL-UNNAMED", "-Duser.language=en", "-Duser.country=US", "-Dfile.encoding=UTF-8")
    systemProperty("pcs.repoRoot", rootProject.projectDir.absolutePath)
    systemProperty("pcs.claimsFile", claimsFile.get().asFile.absolutePath)
    systemProperty("pcs.coversDir", layout.buildDirectory.dir("covers").get().asFile.absolutePath)
    systemProperty("pcs.screenshots", screenshotDir.get().asFile.absolutePath)
    // local visual review (Roborazzi): -Ppcs.visual=record|compare; baselines stay out of git
    providers.gradleProperty("pcs.visual").orNull?.let {
        systemProperty("pcs.visual", it)
        systemProperty(if (it == "record") "roborazzi.test.record" else "roborazzi.test.verify", "true")
    }
    systemProperty("pcs.visualBaselines", layout.projectDirectory.dir("visual-baselines").asFile.absolutePath)
}

tasks.withType<Test>().configureEach { doFirst { layout.buildDirectory.dir("covers").get().asFile.deleteRecursively() } }

compose.desktop {
    application {
        mainClass = "pcs.app.MainKt"
        // jpackage and jlink come from the same JDK 25 the code is built with, not whatever runs Gradle
        javaHome = javaToolchains.launcherFor { languageVersion.set(JavaLanguageVersion.of(25)) }.get().metadata.installationPath.asFile.absolutePath
        jvmArgs("--enable-native-access=ALL-UNNAMED")
        nativeDistributions {
            targetFormats(TargetFormat.Deb, TargetFormat.Dmg, TargetFormat.Msi)
            packageName = "pc-supervisor"
            packageVersion = appVersion
            description = "Supervises a HotCRP review process for the conference chairs"
            vendor = "PC Supervisor contributors"
            includeAllModules = true // trimmed once the module list is measured (suggestRuntimeModules)
            macOS {
                bundleID = "org.pcsupervisor.app"
                // Signing and notarization run only in the release workflow, where these come from CI secrets;
                // every other build, local ones included, is unsigned.
                signing {
                    sign.set(providers.environmentVariable("PCS_MAC_SIGN").map { it == "true" }.orElse(false))
                    identity.set(providers.environmentVariable("PCS_MAC_IDENTITY"))
                }
                notarization {
                    appleID.set(providers.environmentVariable("PCS_APPLE_ID"))
                    password.set(providers.environmentVariable("PCS_APPLE_APP_PASSWORD"))
                    teamID.set(providers.environmentVariable("PCS_APPLE_TEAM_ID"))
                }
            }
            windows { menuGroup = "PC Supervisor" }
            linux { menuGroup = "Office" }
        }
    }
}
