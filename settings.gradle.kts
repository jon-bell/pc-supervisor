pluginManagement {
    repositories {
        gradlePluginPortal()
        mavenCentral()
    }
}

dependencyResolutionManagement {
    repositories {
        mavenCentral()
    }
}

rootProject.name = "pc-supervisor"

// Modules are added by the milestone that first needs them (PLAN.md): app (M4), agent (M8).
include("core", "cli", "seed")
