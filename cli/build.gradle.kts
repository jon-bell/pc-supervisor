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
}

application {
    mainClass.set("pcs.cli.MainKt")
    applicationName = "pcs"
}
