package net.jonbell.pcs.agent.qualify

import net.jonbell.pcs.agent.engines.Adapter
import net.jonbell.pcs.agent.engines.EngineConfigException
import net.jonbell.pcs.agent.engines.EngineConfigs
import net.jonbell.pcs.agent.engines.EngineFactory
import net.jonbell.pcs.agent.eval.HeldOut
import net.jonbell.pcs.agent.eval.Shootout
import net.jonbell.pcs.agent.eval.ShootoutEngine
import net.jonbell.pcs.agent.eval.ShootoutOptions
import java.io.File
import java.nio.file.Path
import java.time.Instant
import java.time.temporal.ChronoUnit

/**
 * `pcs agent qualify --engines ids [--k 3] [--checks a,b] [--out records.json] [--confirm-spend]` and
 * `pcs agent plan --changes [--moves] [--confirm-spend]` (agent.md §4.4, §7.4).
 *
 * `qualify` runs the held-out evaluation on engines configured in the environment and writes a record for each
 * (check version, engine, model, variant) that meets the check's own thresholds (`qualification.yaml`). Like
 * `shootout` it prints what it would call and stops unless `--confirm-spend` is given for an engine that is not a replay.
 * `plan --changes` classifies what is routed now against the records, and with `--moves` runs the held-out evaluation
 * for each changed check to list the flags the change moves. It never touches confidential data: held-out is synthetic.
 */
class QualifyCli(private val env: Map<String, String>, private val out: Appendable = System.out, private val agentDir: File = File(env["PCS_AGENT_DIR"] ?: "agent")) {
    private val checksRoot: Path get() = Path.of(env["PCS_AGENT_CHECKS"] ?: File(agentDir, "checks").path)
    private val recordsPath: Path? get() = env["PCS_AGENT_QUALIFICATIONS"]?.let { Path.of(it) }

    private fun engines(ids: List<String>): List<ShootoutEngine> {
        val configs = EngineConfigs.parse(env).associateBy { it.id }
        val unknown = ids.filter { it !in configs }
        if (unknown.isNotEmpty()) throw EngineConfigException(listOf("no engine configured for: $unknown"))
        return ids.map { id ->
            val reg = EngineFactory.create(configs.getValue(id), env)
            ShootoutEngine(reg.config, { _, _ -> reg.engine }, standIn = false, note = "configured in the environment", gpuUsdPerHour = env["PCS_ENGINE_${id}_GPU_HOUR_USD"]?.toDoubleOrNull() ?: 0.0)
        }
    }

    private fun now() = (env["PCS_NOW"] ?: Instant.now().truncatedTo(ChronoUnit.SECONDS).toString())

    fun qualify(args: List<String>): Int {
        var ids = emptyList<String>()
        var k = 3
        var checks: Set<String>? = null
        var dest = recordsPath
        var confirm = false
        var i = 0
        while (i < args.size) {
            when (args[i]) {
                "--engines" -> ids = args[++i].split(',').map { it.trim() }.filter { it.isNotEmpty() }
                "--k" -> k = args[++i].toInt()
                "--checks" -> checks = args[++i].split(',').map { it.trim() }.toSet()
                "--out" -> dest = Path.of(args[++i])
                "--confirm-spend" -> confirm = true
                else -> {
                    out.appendLine("unknown option ${args[i]}")
                    return 2
                }
            }
            i++
        }
        if (ids.isEmpty() || dest == null) {
            out.appendLine("usage: pcs agent qualify --engines <ids> [--k 3] [--checks a,b] [--out records.json | PCS_AGENT_QUALIFICATIONS] [--confirm-spend]")
            return 2
        }
        return try {
            val es = engines(ids)
            val spends = es.filter { it.config.adapter != Adapter.REPLAY }
            if (spends.isNotEmpty() && !confirm) {
                out.appendLine("# plan only: ${spends.joinToString { it.id }} would be called live on the held-out corpus (synthetic papers), k=$k. Nothing was called; add --confirm-spend.")
                return 2
            }
            val report = Shootout.run(HeldOut.generate(), es, agentDir, ShootoutOptions(k = k, rawVariant = false, checks = checks))
            val outcome = Qualifier.qualify(report, es, checksRoot, agentDir.toPath(), now())
            QualificationFile.save(dest, QualificationFile.load(dest), outcome.records)
            outcome.records.forEach { out.appendLine("qualified ${it.check}@${it.version} on ${it.engine}/${it.model}: ${it.evidence}") }
            outcome.notes.forEach { out.appendLine("note: $it") }
            out.appendLine("# wrote ${outcome.records.size} record(s) to $dest")
            0
        } catch (e: EngineConfigException) {
            out.appendLine("configuration problems:\n  " + e.problems.joinToString("\n  "))
            1
        }
    }

    fun planChanges(args: List<String>): Int {
        val moves = "--moves" in args
        val confirm = "--confirm-spend" in args
        val routing = EngineConfigs.routing(env)
        val configs = EngineConfigs.parse(env)
        val records = QualificationFile.load(recordsPath)
        val changes = ChangePlanner.classify(checksRoot, agentDir.toPath(), routing, configs, records)
        val found = mutableMapOf<String, List<FlagMove>>()
        if (moves) {
            for (c in changes.filter { it.cls != ChangeClass.COVERED }) {
                val base = records.filter { it.check == c.check && it.engine == (configs.firstOrNull { e -> e.id == c.engine }?.identity?.id ?: c.engine) }.maxWithOrNull(compareBy({ it.at }, { it.version }))
                if (base == null || base.flags.isEmpty()) continue
                val es = engines(listOf(c.engine))
                if (es.any { it.config.adapter != Adapter.REPLAY } && !confirm) {
                    out.appendLine("# --moves would call ${c.engine} on the held-out corpus for ${c.check}; add --confirm-spend. Nothing was called.")
                    continue
                }
                val r = Shootout.run(HeldOut.generate(), es, agentDir, ShootoutOptions(k = 1, rawVariant = false, checks = setOf(c.check)))
                val now = r.flagSets[c.engine].orEmpty().mapValues { (_, s) -> s.filter { it.substringBefore('|') == c.check } }
                found[c.check] = ChangePlanner.moves(base.flags, now)
            }
        }
        out.append(ChangePlanner.render(changes, found))
        return if (changes.any { it.cls != ChangeClass.COVERED }) 3 else 0
    }
}
