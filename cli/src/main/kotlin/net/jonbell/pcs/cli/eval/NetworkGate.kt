package net.jonbell.pcs.cli.eval

/** Thrown when the kit is about to open a connection nobody asked for. */
class OfflineViolation(what: String) : IllegalStateException("pcs eval is offline unless you ask otherwise; refusing to open: $what")

/**
 * The one place the kit asks before it can touch a network (PLAN M21, "offline by default"). Everything that can connect goes through
 * [open]: the HotCRP client (only with `--token`) and an engine (only with `--engine`, and then only the adapters that call out). The reference
 * resolver is never configured, and a deterministic run constructs neither, so a run with neither flag calls [open] zero times.
 * A test passes a gate that throws on every call; [NetworkGate.requested] says what a real run asked for, which the report prints.
 */
fun interface NetworkGate {
    /** [purpose] is `hotcrp` or `engine:<adapter>`. Throws [OfflineViolation] if the run did not ask for it. */
    fun open(purpose: String)

    companion object {
        /** A gate that refuses everything. */
        val CLOSED: NetworkGate = NetworkGate { throw OfflineViolation(it) }
    }
}

/** The gate of a real run: it allows exactly what the command line asked for, and records it for the report. */
class RequestedNetwork(private val allowed: Set<String>) : NetworkGate {
    private val used = java.util.TreeSet<String>()

    override fun open(purpose: String) {
        if (purpose !in allowed) throw OfflineViolation(purpose)
        used += purpose
    }

    /** What was opened, sorted. Empty for an offline run. */
    val requested: Set<String> get() = used
}
