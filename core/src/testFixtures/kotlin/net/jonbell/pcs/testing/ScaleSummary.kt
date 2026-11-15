package net.jonbell.pcs.testing

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.nio.file.Files
import java.nio.file.Path
import kotlin.io.path.extension
import kotlin.io.path.listDirectoryEntries

/** Renders the T9 records of a scale run (the json files under `<dir>/records` and `<dir>/facts.json`) as the markdown the nightly job puts in its summary. */
public object ScaleSummary {
    private fun mib(b: Long) = "%.1f MiB".format(b / 1048576.0)

    private fun sec(ms: Long) = if (ms >= 10_000) "%.1f s".format(ms / 1000.0) else "$ms ms"

    public fun render(dir: Path): String {
        val records =
            dir.resolve("records").takeIf { Files.isDirectory(it) }?.listDirectoryEntries()?.filter { it.extension == "json" }.orEmpty().sorted()
                .map { Json.parseToJsonElement(Files.readString(it)).jsonObject }
        val facts = dir.resolve("facts.json").takeIf { Files.exists(it) }?.let { Json.parseToJsonElement(Files.readString(it)).jsonObject }
        return buildString {
            appendLine("## Scale scenario (T9, `prop:Q1`)")
            appendLine()
            if (records.isEmpty()) {
                appendLine("No measurement records were written: the scale test did not get that far.")
                return@buildString
            }
            val w = records.first()["workload"]!!.jsonObject
            appendLine(
                "Workload: scale scenario, ${w["papers"]} papers, ${w["reviews"]} reviews, ${w["comments"]} comments, ${w["pcMembers"]} PC members. " +
                    "Environment: ${records.first()["environment"]!!.jsonObject.let {
                        "${it["os"]!!.jsonPrimitive.content}, ${it["cpus"]} CPUs, ${it["jvm"]!!.jsonPrimitive.content}, runner ${it["runner"]!!.jsonPrimitive.content}"
                    }}.",
            )
            appendLine()
            appendLine("| Metric | Runs | Median | 95th percentile | 95% CI (bootstrap) | Budget | Within budget |")
            appendLine("|---|---|---|---|---|---|---|")
            for (r in records) {
                val st = r["statistic"]!!.jsonObject
                val ci = st["ciMs"]!!.jsonArray.map { it.jsonPrimitive.content.toLong() }
                val b = r["budgetMs"]!!.jsonPrimitive.content.toLong()
                val ok = r["verdict"]!!.jsonObject["withinBudget"]!!.jsonPrimitive.content == "true"
                appendLine(
                    "| `${r["metric"]!!.jsonPrimitive.content}` | ${r["samplesMs"]!!.jsonArray.size} | ${sec(
                        st["median"]!!.jsonPrimitive.content.toLong(),
                    )} | " +
                        "${sec(st["p95Ms"]!!.jsonPrimitive.content.toLong())} | ${sec(ci[0])} to ${sec(ci[1])} | ${sec(b)} | ${if (ok) "yes" else "**NO**"} |",
                )
            }
            appendLine()
            val n = records.minOf { it["samplesMs"]!!.jsonArray.size }
            val confidence = (100 * (1 - Math.pow(0.95, n.toDouble()))).toInt()
            appendLine(
                "Each row: the 95th percentile (nearest rank) of the runs and its percentile-bootstrap interval; a budget holds when both are within it. " +
                    "With $n runs a clean row shows fewer than 5% of runs over budget at $confidence% confidence (59 clean runs give 95%; the nightly job takes 59).",
            )
            if (facts != null) {
                appendLine()
                appendLine("### Store")
                appendLine()
                facts["dbBytes"]?.let {
                    appendLine(
                        "- Database size: **${mib(
                            it.jsonPrimitive.content.toLong(),
                        )}** (encrypted SQLite, after the full sync, the re-syncs and the affinity import)",
                    )
                }
                (facts["dbTables"] as? JsonObject)?.let { t ->
                    appendLine(
                        "- Rows: " + t.entries.joinToString(", ") { "${it.key} ${it.value.jsonPrimitive.content}" },
                    )
                }
                facts["tpmsRows"]?.let { appendLine("- Affinity import: $it tpms-scores rows") }
                (facts["analysisMs"] as? JsonObject)?.let { t ->
                    appendLine()
                    appendLine("### Single timings (informational, no budget)")
                    appendLine()
                    t.forEach { (k, v) -> appendLine("- $k: ${sec(v.jsonPrimitive.content.toLong())}") }
                }
                (facts["solve"] as? JsonObject)?.let { t ->
                    appendLine()
                    appendLine("### Solve")
                    appendLine()
                    appendLine(t.entries.joinToString(", ") { "${it.key} ${it.value.jsonPrimitive.content}" })
                }
            }
        }
    }

    @JvmStatic
    public fun main(args: Array<String>) {
        val dir = Path.of(args[0])
        val md = render(dir)
        Files.createDirectories(dir)
        Files.writeString(dir.resolve("summary.md"), md)
        print(md)
    }
}
