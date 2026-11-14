package pcs.agent

import pcs.agent.checks.Finding
import pcs.agent.checks.Screening
import pcs.agent.eval.Corpus
import pcs.agent.eval.Generated
import pcs.agent.eval.Scoring

/** The synthetic corpus and one screening of each paper, shared by the test classes (generated once per JVM). */
object TestCorpus {
    val items: List<Generated> by lazy { Corpus.generate() }

    val screened: Map<String, Screening.Screened> by lazy { items.associate { it.entry.id to Screening.screen(it.bytes, Scoring.config(it.entry)) } }

    fun item(id: String) = items.first { it.entry.id == id }

    fun findings(id: String): List<Finding> = screened.getValue(id).report.findings

    val clean get() = items.filter { it.entry.kind == "clean" }
    val benign get() = items.filter { it.entry.kind == "benign" }
    val mutants get() = items.filter { it.entry.kind == "mutant" }
}
