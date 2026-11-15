package net.jonbell.pcs.agent.llm

import java.nio.file.Files
import java.nio.file.Path

/**
 * Where the scope check gets the call's topic list (owner's ruling, 2026-11-15): a text file the chair sets in
 * `PCS_AGENT_CFP`, kept with the conference config. There is no built-in default. A file that is not set, not there, or empty
 * is a stated problem, and it makes the decision `scope.cfp` unresolved, so the scope check is blocked in the manifest
 * and the bundle's manifest says so, instead of the check quietly running on nothing.
 *
 * This is not check code (it is outside every check's file list), so no check version and no fixture changes.
 */
sealed class Cfp {
    data class Present(val text: String, val path: String) : Cfp()

    data class Missing(val problem: String) : Cfp()

    val textOrNull: String? get() = (this as? Present)?.text
}

object CfpSource {
    const val ENV = "PCS_AGENT_CFP"
    const val DECISION = "scope.cfp"

    /** [explicit] is a `--cfp` option; it wins over the environment. */
    fun resolve(env: Map<String, String>, explicit: String? = null): Cfp {
        val path = explicit?.takeIf { it.isNotBlank() } ?: env[ENV]?.takeIf { it.isNotBlank() }
        if (path == null) return Cfp.Missing("no call-for-papers file: $ENV is not set (and no --cfp was given), so the scope check has no topic list")
        val p = Path.of(path)
        if (!Files.isRegularFile(p)) return Cfp.Missing("the call-for-papers file $path does not exist or is not a file")
        val text = Files.readString(p)
        if (text.isBlank()) return Cfp.Missing("the call-for-papers file $path is empty")
        return Cfp.Present(text, path)
    }

    /** With no usable CFP, `scope.cfp` is unresolved whatever the decision file says; with one, the decisions are as they were. */
    fun overlay(decisions: Decisions, cfp: Cfp): Decisions {
        if (cfp !is Cfp.Missing) return decisions
        val old = decisions[DECISION]
        val reopened =
            Decision(
                DECISION,
                old?.title ?: "Which call text defines scope",
                DecisionStatus.UNRESOLVED,
                "Unresolved: ${cfp.problem}.",
                old?.ownerRole ?: "program chairs",
                null,
                "$ENV",
            )
        return Decisions(decisions.all.filter { it.id != DECISION } + reopened)
    }

    /** The line a CLI prints when the scope check is routed and has no CFP. Null when there is nothing to say. */
    fun warning(routing: Map<String, String>, cfp: Cfp): String? =
        if ("scope" in routing && cfp is Cfp.Missing) "scope: BLOCKED, scope.cfp is unresolved: ${cfp.problem}. The scope check did not run." else null
}
