import org.jetbrains.compose.desktop.application.dsl.TargetFormat
import java.io.IOException
import java.net.InetSocketAddress
import java.net.Socket
import java.net.URI

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
    testImplementation(libs.serialization.json)
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
    configureUiTestCommon("covers")
}

// ---- the harness the UI tests need, and when `check` runs them
// The harness settings come from the environment, else from `.env.test` at the repo root (what scripts/hotcrp-up.sh writes), so
// `./gradlew check` needs no `set -a; . ./.env.test`.
val harnessKeys = listOf("PCS_HOTCRP_URL", "PCS_HOTCRP_TOKEN")
val envTestFile = rootProject.layout.projectDirectory.file(".env.test").asFile
val envTest: Map<String, String> =
    if (envTestFile.isFile) {
        envTestFile.readLines().map { it.trim() }.filter { it.isNotEmpty() && !it.startsWith("#") && '=' in it }
            .associate { it.substringBefore('=').trim() to it.substringAfter('=').trim().removeSurrounding("\"") }
    } else {
        emptyMap()
    }
val harnessEnv: Map<String, String> = harnessKeys.mapNotNull { k -> (System.getenv(k)?.takeIf { it.isNotBlank() } ?: envTest[k])?.let { k to it } }.toMap()
val isLinux = System.getProperty("os.name").lowercase().contains("linux")
val hasDisplay = !isLinux || !System.getenv("DISPLAY").isNullOrBlank() || !System.getenv("WAYLAND_DISPLAY").isNullOrBlank()

fun onPath(cmd: String): Boolean = System.getenv("PATH").orEmpty().split(File.pathSeparator).any { File(it, cmd).canExecute() }

/** With no display on Linux but Xvfb installed, the UI test task starts its own Xvfb for the run. */
val needsXvfb = !hasDisplay && onPath("Xvfb")

// Compose UI tests: the ones that need nothing but the app's own resources, and the ones against the
// harness's synced `golden` (tagged "harness"; they need PCS_HOTCRP_URL and PCS_HOTCRP_TOKEN, and
// refuse to run against anything but localhost). CI runs it as its own step on a fresh harness
// (`xvfb-run -a ./gradlew uiTest`), so CI's `check` excludes it (`-x :app:uiTest`).
var xvfb: Process? = null
val uiTest by tasks.registering(Test::class) {
    description = "Compose UI tests; writes screenshots to app/build/screenshots"
    group = "verification"
    testClassesDirs = sourceSets.test.get().output.classesDirs
    classpath = sourceSets.test.get().runtimeClasspath
    useJUnitPlatform { includeTags("ui") }
    configureUiTestCommon("covers-ui")
    doFirst {
        screenshotDir.get().asFile.deleteRecursively()
        if (needsXvfb) {
            val p = ProcessBuilder("Xvfb", "-displayfd", "1", "-screen", "0", "1920x1080x24", "-nolisten", "tcp").redirectErrorStream(false).start()
            xvfb = p
            val n = p.inputStream.bufferedReader().readLine()?.trim()
            check(!n.isNullOrEmpty()) { "Xvfb did not report a display" }
            environment("DISPLAY", ":$n")
            logger.lifecycle("uiTest: no display, so started Xvfb on :$n")
        }
    }
    harnessEnv.forEach { (k, v) -> environment(k, v) }
    outputs.upToDateWhen { false }
    // the process never touches the user's keychain or conference directory
    environment("PCS_CONFERENCES", layout.buildDirectory.dir("ui-conferences").get().asFile.absolutePath)
    finalizedBy("uiTestStopXvfb")
}

tasks.register("uiTestStopXvfb") {
    doLast {
        xvfb?.destroy()
        xvfb = null
    }
}

// `check` includes uiTest only when it can run: a harness is configured (PCS_HOTCRP_URL and token in the environment or in .env.test),
// it is localhost and answers, and there is a display (or Xvfb). Otherwise `check` says why it skipped and still passes, so
// `./gradlew check` works on a laptop with no harness. `./gradlew :app:uiTest` always runs and fails loudly when it can't.
val checkRequested = gradle.startParameter.taskNames.any { it == "check" || it.endsWith(":check") }
val uiTestSkipReason: String? =
    when {
        harnessKeys.any {
            it !in harnessEnv
        } -> "no harness configured (set PCS_HOTCRP_URL and PCS_HOTCRP_TOKEN, or run scripts/hotcrp-up.sh to write .env.test)"
        !checkRequested -> null
        else -> {
            val url = URI(harnessEnv.getValue("PCS_HOTCRP_URL"))
            when {
                url.host !in
                    setOf(
                        "127.0.0.1",
                        "localhost",
                        "::1",
                        "[::1]",
                    )
                -> "the configured HotCRP (${url.host}) is not localhost; the UI tests run only against the local harness"
                !hasDisplay && !needsXvfb -> "no display (DISPLAY is unset) and no Xvfb on the PATH: install xvfb or run under xvfb-run"
                else ->
                    try {
                        Socket().use { it.connect(InetSocketAddress(url.host, if (url.port > 0) url.port else 80), 1000) }
                        null
                    } catch (e: IOException) {
                        "the harness at ${url.host}:${url.port} does not answer (start it with scripts/hotcrp-up.sh)"
                    }
            }
        }
    }
tasks.named("check") {
    if (uiTestSkipReason == null) {
        dependsOn(uiTest)
    } else {
        doLast { logger.lifecycle("uiTest skipped by check: $uiTestSkipReason") }
    }
}

fun Test.configureUiTestCommon(coversName: String) {
    dependsOn(claimsInventory)
    jvmArgs("--enable-native-access=ALL-UNNAMED", "-Duser.language=en", "-Duser.country=US", "-Dfile.encoding=UTF-8")
    systemProperty("pcs.repoRoot", rootProject.projectDir.absolutePath)
    systemProperty("pcs.claimsFile", claimsFile.get().asFile.absolutePath)
    systemProperty("pcs.coversDir", layout.buildDirectory.dir(coversName).get().asFile.absolutePath)
    doFirst { layout.buildDirectory.dir(coversName).get().asFile.deleteRecursively() }
    systemProperty("pcs.screenshots", screenshotDir.get().asFile.absolutePath)
    // local visual review (Roborazzi): -Ppcs.visual=record|compare; baselines stay out of git
    providers.gradleProperty("pcs.visual").orNull?.let {
        systemProperty("pcs.visual", it)
        systemProperty(if (it == "record") "roborazzi.test.record" else "roborazzi.test.verify", "true")
    }
    systemProperty("pcs.visualBaselines", layout.projectDirectory.dir("visual-baselines").asFile.absolutePath)
}

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
            // Not includeAllModules: Temurin 25 ships no jmods (JEP 493), and jlink then refuses an image that contains jdk.jlink.
            // The list is `suggestRuntimeModules` plus what it can't see: TLS and naming for the HotCRP client, the JDBC driver's java.sql,
            // the keychain's AWT-free JNA needs none, and the zip/charset/locale providers that load by service lookup.
            modules(
                "java.desktop",
                "java.instrument",
                "java.logging",
                "java.management",
                "java.naming",
                "java.net.http",
                "java.prefs",
                "java.security.jgss",
                "java.sql",
                "jdk.charsets",
                "jdk.crypto.cryptoki",
                "jdk.crypto.ec",
                "jdk.localedata",
                "jdk.management",
                "jdk.security.auth",
                "jdk.unsupported",
                "jdk.zipfs",
            )
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
        buildTypes.release.proguard {
            // ProGuard stops on the unresolved members of the serialization, SQLite and Ktor jars, and the app is small enough
            // that shrinking is not worth keep rules for every reflective path. The release package is the plain jlink'd one.
            isEnabled.set(false)
        }
    }
}
