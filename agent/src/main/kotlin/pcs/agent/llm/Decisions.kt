package pcs.agent.llm

import org.snakeyaml.engine.v2.api.Load
import org.snakeyaml.engine.v2.api.LoadSettings
import pcs.agent.engines.Keys
import java.nio.file.Files
import java.nio.file.Path

/** `status ∈ settled | provisional | assumed | unresolved | referred` (agent.md §3.1). */
enum class DecisionStatus(val key: String) {
    SETTLED("settled"),
    PROVISIONAL("provisional"),
    ASSUMED("assumed"),
    UNRESOLVED("unresolved"),
    REFERRED("referred"),
    ;

    companion object {
        fun ofKey(k: String) = entries.firstOrNull { it.key == k }
    }
}

/** One policy choice the agent depends on. Concepts.md calls it a ruling. */
data class Decision(
    val id: String,
    val title: String,
    val status: DecisionStatus,
    val statement: String,
    val ownerRole: String,
    val decidedAt: String?,
    val source: String?,
    val supersedes: String? = null,
) {
    /** Changes with the status or the statement, so a change reruns exactly the checks that cite this decision (agent.md §4.4). */
    val version: String get() = Keys.sha256("$id\u0000${status.key}\u0000$statement").take(12)

    /** The token that goes into a request's key. */
    val keyToken: String get() = "$id@$version"
}

class DecisionFileException(val problems: List<String>) : RuntimeException(problems.joinToString("; "))

/**
 * The decision file (`PCS_AGENT_DECISIONS`, a YAML file outside the repo). A check that cites a
 * decision the file does not have is treated as depending on an `unresolved` one: nobody has decided
 * it, so what depends on it is blocked.
 */
class Decisions(decisions: List<Decision>) {
    private val byId = decisions.associateBy { it.id }

    init {
        require(byId.size == decisions.size) { "two decisions with the same id" }
    }

    val all: List<Decision> get() = byId.values.toList()

    operator fun get(id: String): Decision? = byId[id]

    fun statusOf(id: String): DecisionStatus = byId[id]?.status ?: DecisionStatus.UNRESOLVED

    /** The cited decisions that are unresolved or missing, in the order given. */
    fun blockers(ids: List<String>): List<String> = ids.filter { statusOf(it) == DecisionStatus.UNRESOLVED }

    /** Tokens for a request key: the version of each cited decision (`id@none` if there is no record). */
    fun keyTokens(ids: List<String>): List<String> = ids.map { id -> byId[id]?.keyToken ?: "$id@none" }

    companion object {
        val EMPTY = Decisions(emptyList())

        fun load(path: Path): Decisions = parse(Files.readString(path))

        @Suppress("UNCHECKED_CAST")
        fun parse(yaml: String): Decisions {
            val root =
                Load(LoadSettings.builder().build()).loadFromString(yaml) as? Map<String, Any?> ?: throw DecisionFileException(listOf("not a YAML mapping"))
            val list = root["decisions"] as? List<Map<String, Any?>> ?: throw DecisionFileException(listOf("no `decisions:` list"))
            val problems = mutableListOf<String>()
            val out =
                list.mapIndexedNotNull { i, m ->
                    fun s(k: String) = m[k]?.toString()?.trim()?.takeIf { it.isNotEmpty() }
                    val id = s("id")
                    if (id == null) {
                        problems += "decision #$i has no id"
                        return@mapIndexedNotNull null
                    }
                    val status = s("status")?.let { DecisionStatus.ofKey(it) }
                    if (status == null) {
                        problems += "$id: status must be one of ${DecisionStatus.entries.map { it.key }}, got ${s("status")}"
                        return@mapIndexedNotNull null
                    }
                    for (k in listOf("title", "statement", "owner_role")) if (s(k) == null) problems += "$id: $k is required"
                    Decision(
                        id,
                        s("title").orEmpty(),
                        status,
                        s("statement").orEmpty(),
                        s("owner_role").orEmpty(),
                        s("decided_at"),
                        s("source"),
                        s("supersedes"),
                    )
                }
            val dup = out.groupBy { it.id }.filter { it.value.size > 1 }.keys
            if (dup.isNotEmpty()) problems += "duplicate ids: $dup"
            if (problems.isNotEmpty()) throw DecisionFileException(problems)
            return Decisions(out)
        }
    }
}
