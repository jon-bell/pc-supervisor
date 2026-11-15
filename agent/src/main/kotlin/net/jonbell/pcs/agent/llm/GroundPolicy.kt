package net.jonbell.pcs.agent.llm

/**
 * Which flags may carry a desk-reject ground when they leave the agent (owner's ruling, 2026-11-15). This is a mapping over
 * stored flags, not check code, so it changes no check version and no replay fixture.
 *
 * - A verified `injection.effect` flag of kind `output-differs` (the output changed when a span addressed to an AI reader was
 *   removed) carries `prompt-injection`. Its monitor flags (an unasked verdict, a refusal, and so on) are signals, with no ground.
 * - A `refs.use` flag is evidence only: it never carries a removal ground, whatever the check stored.
 * - Every other flag keeps its stored ground.
 */
object GroundPolicy {
    const val PROMPT_INJECTION = "prompt-injection"
    private const val EFFECT = "injection.effect"
    private const val EFFECT_KIND = "output-differs"
    private const val REFS_USE = "refs.use"

    fun groundOf(flag: Flag): String? =
        when {
            flag.check == REFS_USE -> null
            flag.check == EFFECT -> if (flag.kind == EFFECT_KIND && flag.verified) PROMPT_INJECTION else null
            else -> flag.ground
        }

    /** True for a flag that is shown as evidence for a person and is never a ground by itself. */
    fun evidenceOnly(flag: Flag): Boolean = flag.check == REFS_USE
}
