package pcs.core.readings

import java.nio.file.Files
import java.nio.file.Path

/**
 * The answers file (spec §4.1): `Qn = <reading key>` lines, `#` comments, and `scale.*`
 * lines that only the model reads. The same format and the same rules as the Lean parser
 * (`parseAnswers` in model/ReviewProcess/Validate.lean); a test checks that both give the
 * same readings for model/answers/synthetic.txt.
 */
public data class Answers(
    val readings: Readings,
    val given: List<Pair<QId, String>>,
    val errors: List<String>,
) {
    /** Questions with no answer. Whatever depends on them is blocked (concepts §3.1). */
    public val unresolved: List<QId> get() = QId.entries.filter { readings[it] == null }

    public companion object {
        public fun read(path: Path): Answers = parse(Files.readString(path))

        public fun parse(text: String): Answers {
            var r = Readings()
            val given = mutableListOf<Pair<QId, String>>()
            val errors = mutableListOf<String>()
            for (raw in text.split("\n")) {
                val line = raw.substringBefore('#').trim()
                if (line.isEmpty()) continue
                val parts = line.split("=")
                if (parts.size != 2) {
                    errors += "cannot read: $line"
                    continue
                }
                val k = parts[0].trim()
                val v = parts[1].trim()
                if (k.startsWith("scale.")) {
                    if (v.toIntOrNull() == null) errors += "$k: not a number: $v"
                    continue
                }
                val q = QId.ofCode(k)
                if (q == null) {
                    errors += "unknown question $k"
                    continue
                }
                val next = r.with(q, v)
                if (next == null) {
                    errors += "$k: unknown reading $v; one of ${q.readings.map { it.key }}"
                    continue
                }
                r = next
                given += q to v
            }
            return Answers(r, given, errors)
        }
    }
}
