package net.jonbell.pcs.agent.engines

/**
 * Serves recorded results by content address (agent.md §4.3) and never calls out. CI runs every
 * check through it, and a view can be re-rendered with it without spending tokens. A key with no
 * recording is an ERROR, never a fall-through to a live engine.
 */
class ReplayEngine(override val id: String, private val recordings: ResultStore) : Engine {
    override val caps = Caps(Structured.NATIVE, pdfInput = true, maxInputTokens = Int.MAX_VALUE, batch = false, promptCache = false, toolLoop = ToolLoop.NONE)

    /** How many results are recorded, by check id (for `pcs agent probe`). */
    fun recorded(): Map<String, Int> = recordings.all().filter { it.result != null }.groupingBy { it.checkId }.eachCount().toSortedMap()

    override suspend fun call(req: CallRequest): CallResult {
        val hit =
            recordings.get(req.key)?.result
                ?: return CallResult(req.key, Status.ERROR, detail = "no recording for key ${req.key.take(12)} (check ${req.check.id}@${req.check.version})")
        return hit.copy(key = req.key)
    }
}
