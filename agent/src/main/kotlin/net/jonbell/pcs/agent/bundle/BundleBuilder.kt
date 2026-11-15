package net.jonbell.pcs.agent.bundle

import net.jonbell.pcs.agent.engines.PaperInput
import net.jonbell.pcs.agent.llm.Flag
import net.jonbell.pcs.agent.llm.FlagAnchor
import net.jonbell.pcs.agent.llm.FlagStatus
import net.jonbell.pcs.agent.llm.ManifestRow
import net.jonbell.pcs.agent.llm.PaperScreen
import net.jonbell.pcs.agent.llm.Qualification
import net.jonbell.pcs.agent.llm.SummaryView
import net.jonbell.pcs.core.bundle.BundleAnchor
import net.jonbell.pcs.core.bundle.BundleFinding
import net.jonbell.pcs.core.bundle.BundleManifest
import net.jonbell.pcs.core.bundle.BundleManifestRow
import net.jonbell.pcs.core.bundle.BundlePaper
import net.jonbell.pcs.core.bundle.BundlePayload
import net.jonbell.pcs.core.bundle.BundleQualification
import net.jonbell.pcs.core.bundle.BundleSummary
import net.jonbell.pcs.core.bundle.BundleSummaryItem

/**
 * Turns what screening produced into the bundle's payload (agent.md §6, spec §10.3). The bundle holds findings,
 * the summaries, the manifest and the qualification records the run relied on: never the PDFs, only their hashes.
 * Nothing in it writes to HotCRP or says what to do with a paper: the agent only flags.
 */
object BundleBuilder {
    private fun anchor(a: FlagAnchor) = BundleAnchor(a.source, a.quote, a.start, a.end, a.page, a.channel, a.ref, a.label)

    fun finding(f: Flag) =
        BundleFinding(
            f.pid,
            f.check,
            f.version,
            f.kind,
            f.ground,
            f.severity.name,
            if (f.status == FlagStatus.VERIFIED) BundleFinding.VERIFIED else BundleFinding.UNVERIFIED,
            f.engine,
            f.key,
            f.dependsOn,
            // An unverified flag's quotation was not found where it was said to be; it travels as a count of one flag, never as text.
            if (f.verified) f.anchors.map(::anchor) else emptyList(),
            if (f.verified) f.fields else f.fields.filterKeys { it.startsWith("measured.") },
        )

    fun summary(pid: String, s: SummaryView) = BundleSummary(pid, s.check, s.version, s.engine, s.key, s.items.map { BundleSummaryItem(it.section, it.text, anchor(it.anchor)) }, s.dropped)

    fun build(
        papers: List<PaperInput>,
        screens: List<PaperScreen>,
        rows: List<ManifestRow>,
        qualifications: List<Qualification>,
        createdAt: String,
    ): BundlePayload {
        val engines = sortedMapOf<String, String>()
        for (s in screens) {
            s.flags.forEach { engines.putIfAbsent(it.engine, "") }
            s.calls.filter { it.servedModel.isNotEmpty() }.forEach { c -> s.flags.map { it.engine }.distinct().forEach { e -> if (engines[e].isNullOrEmpty() && e != "local") engines[e] = c.servedModel } }
        }
        val current = rows.associate { it.check to it.version }
        val manifest =
            BundleManifest(
                createdAt = createdAt,
                papers = papers.map { BundlePaper(it.id, it.sha256, it.dataClass.name.lowercase()) },
                checks =
                    rows.map { r ->
                        BundleManifestRow(r.check, r.version, r.category, r.qualifiedOn, r.decisions.map { (id, st) -> "$id=${st?.key ?: "unresolved"}" }, r.affected)
                    },
                qualifications =
                    qualifications.filter { current[it.check] == it.version }
                        .map { BundleQualification(it.check, it.version, it.engine, it.model, it.variant, it.evidence) },
                engines = engines,
            )
        return BundlePayload(manifest, screens.flatMap { s -> s.flags.map(::finding) }, screens.mapNotNull { s -> s.summary?.let { summary(s.pid, it) } }).canonical()
    }
}
