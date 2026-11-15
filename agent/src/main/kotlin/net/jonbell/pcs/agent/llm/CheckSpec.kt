package net.jonbell.pcs.agent.llm

import org.snakeyaml.engine.v2.api.Load
import org.snakeyaml.engine.v2.api.LoadSettings
import java.nio.file.Files
import java.nio.file.Path

/** What a check directory's `check.yaml` says (agent.md §3.2). */
data class CheckSpec(
    val id: String,
    /** `deterministic`, `llm`, `differential`, or `escalated`. */
    val category: String,
    val dependsOn: List<String>,
    val inputs: List<String>,
    val grounds: List<String>,
    val evidence: String,
    val affected: String,
    val variant: String?,
    /** How many labelled cases or mutation operators the oracle holds, and how many of those plant a defect. */
    val oracleCases: Int,
    val oraclePositives: Int,
) {
    companion object {
        @Suppress("UNCHECKED_CAST")
        fun read(dir: Path): CheckSpec {
            val m = Load(LoadSettings.builder().build()).loadFromString(Files.readString(dir.resolve("check.yaml"))) as Map<String, Any?>

            fun list(k: String) = (m[k] as? List<Any?>)?.map { it.toString() }.orEmpty()

            fun text(k: String) = m[k]?.toString()?.trim().orEmpty()
            val (cases, positives) = oracle(dir)
            return CheckSpec(
                text("id"),
                text("category"),
                list("depends_on"),
                list("inputs"),
                list("grounds"),
                text("evidence"),
                text("affected"),
                m["variant"]?.toString(),
                cases,
                positives,
            )
        }

        /** Reads `oracle/operators.json` (mutation operators) or `oracle/cases.json` (labelled cases). */
        private fun oracle(dir: Path): Pair<Int, Int> {
            val json = kotlinx.serialization.json.Json
            val ops = dir.resolve("oracle/operators.json")
            val cases = dir.resolve("oracle/cases.json")

            fun arr(p: Path) = json.parseToJsonElement(Files.readString(p)) as kotlinx.serialization.json.JsonArray

            fun str(o: kotlinx.serialization.json.JsonElement, k: String) =
                (o as kotlinx.serialization.json.JsonObject)[k]?.let {
                    (it as? kotlinx.serialization.json.JsonPrimitive)?.content
                }
            return when {
                Files.isRegularFile(ops) -> arr(ops).let { a -> a.size to a.count { str(it, "control") != "true" } }
                Files.isRegularFile(cases) -> arr(cases).let { a -> a.size to a.count { str(it, "kind") == "positive" } }
                else -> 0 to 0
            }
        }

        /** Every check directory under [root] (those with a `check.yaml`), sorted by id. */
        fun readAll(root: Path): List<CheckSpec> =
            Files.list(root).use { s -> s.filter { Files.isRegularFile(it.resolve("check.yaml")) }.toList() }.map { read(it) }.sortedBy { it.id }
    }
}
