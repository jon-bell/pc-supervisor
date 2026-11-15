package net.jonbell.pcs.core.triage

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import net.jonbell.pcs.core.accountability.Tiers
import net.jonbell.pcs.core.bundle.ScreeningBundles
import net.jonbell.pcs.core.imports.ImportKind
import net.jonbell.pcs.core.imports.Imports
import net.jonbell.pcs.core.nominations.NominationData
import net.jonbell.pcs.core.phases.Phase
import net.jonbell.pcs.core.phases.Window
import net.jonbell.pcs.core.rules.Faults
import net.jonbell.pcs.core.rules.Stage
import net.jonbell.pcs.core.rules.Tier
import net.jonbell.pcs.core.session.Session
import net.jonbell.pcs.core.store.query
import java.time.Instant

/** The model's stage of the process at [now], from the phase dates (spec §10.1); with none configured, the screening stage. */
public fun stageAt(phases: Map<String, Instant>, now: Instant): Stage {
    if (phases.isEmpty()) return Stage.SCREENING
    val ph = net.jonbell.pcs.core.phases.Phases(phases)
    val responseOpen = phases[Window.RESPONSE.open]?.let { !now.isBefore(it) } == true
    return when (ph.current(now)) {
        Phase.REGISTRATION, Phase.SUBMISSION, Phase.DESKREJECT -> Stage.SCREENING
        Phase.APPOINTMENTS, Phase.ASSIGNMENT -> Stage.ASSIGNED
        Phase.REVIEWING, Phase.POST_REVIEW -> if (responseOpen) Stage.RELEASED else Stage.IN_REVIEW
        Phase.DISCUSSION, Phase.DECISIONS, Phase.CLOSED -> Stage.RELEASED
    }
}

/** Seniority as the accountability module reads it (the appointments sheet, then tier tags on the person, else senior). */
public fun Session.tiers(): (String) -> Tier? {
    val input = NominationData(store, Imports(store, clock)).input()
    val tags =
        store.conn.query("SELECT lower(email), tags FROM person WHERE gone_at IS NULL") { it.getString(1) to it.getString(2) }
            .associate { (e, t) -> e to Json.parseToJsonElement(t).jsonArray.map { x -> x.jsonPrimitive.content } }
    val tiers = Tiers.build(input.sheet, tags, settings.tierTags)
    return { email -> tiers.of(email).tier }
}

/** The triage queue at the clock's now (spec §10.4 B): reads the mirror, the latest screening bundle and the latest refcheck import. Writes nothing. */
public fun Session.triage(f: Faults = Faults.NONE): TriageReport {
    val imports = Imports(store, clock)
    val bundle = ScreeningBundles(store, imports, clock).latest()
    val refcheck = imports.latest(ImportKind.REFCHECK)?.rows.orEmpty()
    val now = clock.now()
    return TriagePlan.compute(
        store,
        bundle,
        refcheck,
        answers().readings,
        stageAt(settings.phases, now),
        now.epochSecond / 3600,
        tiers(),
        f,
        settings.venue.remedyWindowH,
    )
}

/** The per-AC consistency view and the `prop:M1` band alerts for a ready report. */
public fun Session.consistency(report: TriageReport.Ready): ConsistencyView = Consistency.view(store, report.rows, settings.consistency)
