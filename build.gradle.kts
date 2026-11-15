plugins {
    alias(libs.plugins.kotlin.jvm) apply false
    alias(libs.plugins.kotlin.serialization) apply false
    alias(libs.plugins.ktlint) apply false
    alias(libs.plugins.compose.multiplatform) apply false
    alias(libs.plugins.kotlin.compose) apply false
}

subprojects {
    group = "net.jonbell.pcs"
    apply(plugin = "org.jlleitschuh.gradle.ktlint")
    configure<org.jlleitschuh.gradle.ktlint.KtlintExtension> {
        filter { exclude { it.file.path.contains("/generated/") } }
    }
}

// T9, the scale scenario (PLAN M19), nightly: needs a harness seeded with `scale` (CI's "Scale scenario" step starts one).
// The summary is written even when a test fails; `lake exe check-evidence build/scale/records` then re-derives each verdict.
tasks.register("scaleTest") {
    description = "Runs the scale scenario: sync, re-sync, solve, table render and filter; writes build/scale/summary.md"
    group = "verification"
    dependsOn(":runner:scaleTest", ":app:scaleUiTest")
    finalizedBy(":core:scaleSummary")
}
