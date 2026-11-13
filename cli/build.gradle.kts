plugins {
    alias(libs.plugins.kotlin.jvm)
    application
}

kotlin {
    jvmToolchain(21)
    compilerOptions { allWarningsAsErrors.set(true) }
}

dependencies {
    implementation(project(":core"))
    implementation(libs.coroutines.core)
    implementation(libs.serialization.json)
    runtimeOnly(libs.slf4j.nop)
}

application {
    mainClass.set("pcs.cli.MainKt")
    applicationName = "pcs"
}
