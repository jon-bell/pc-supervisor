package pcs.core

import java.nio.file.Path

object Repo {
    val root: Path = Path.of(System.getProperty("pcs.repoRoot") ?: error("pcs.repoRoot not set; run through Gradle"))
    fun path(rel: String): Path = root.resolve(rel)
}
