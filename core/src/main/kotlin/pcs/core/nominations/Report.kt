package pcs.core.nominations

import pcs.core.readings.QId
import pcs.core.readings.Readings
import pcs.core.rules.Compliance
import pcs.core.rules.Faults
import pcs.core.rules.Nominations
import pcs.core.rules.Nominee
import pcs.core.rules.PaperNoms
import pcs.core.rules.Tier

/*
 * Nominations (concepts §3.3, spec §10.4 A): what each paper names, what each person owes, the
 * patterns across an author's papers, and the authors over the cap. A pure function of the mirror
 * and the latest appointments sheet, under the chairs' answers. The rules are `Nominations`
 * (checked against the Lean model); this file only assembles their inputs. HotCRP holds the
 * papers and their authors; the sheet holds who was nominated (`nominated_by`) and what the AC decided.
 */

public enum class Decision(public val key: String) {
    ACCEPT("accept"),
    DECLINE("decline"),
    PENDING("pending"),
    ;

    public companion object {
        public fun ofKey(k: String): Decision = entries.first { it.key == k }
    }
}

/** One row of the appointments sheet (spec §10.3), as the rules need it. */
public data class Candidate(
    val email: String,
    val origin: String,
    val nominatedBy: List<Long>,
    val area: String,
    val acEmail: String,
    val decision: Decision,
    val tier: Tier?,
    val consent: Boolean?,
    val onPcAt: String,
)

/** A paper as HotCRP shows it: its authors (by account email) and tags. */
public data class PaperInfo(val pid: Long, val title: String, val authors: List<String>, val tags: List<String>)

/** Everything the report reads. [registered] is null when no `tpms-registrations` import exists: registration is then unknown. */
public data class NominationInput(
    val papers: List<PaperInfo>,
    val sheet: List<Candidate>,
    val pc: Set<String>,
    val registered: Set<String>?,
    /** Each paper's ACs (metareviewers), by email: who may decide on a candidate the paper nominated. */
    val acs: Map<Long, Set<String>> = emptyMap(),
)

public data class NomineeStatus(
    val email: String,
    val decision: Decision,
    val tier: Tier?,
    val consent: Boolean?,
    /** Is the nominee one of the paper's authors? Nominees are chosen from among them. */
    val isAuthor: Boolean,
    /** Null when no registration import exists. */
    val registered: Boolean?,
    val onPc: Boolean,
)

/** One paper's nominations, checked against Q8 and, for a paper that fails, Q10. */
public data class PaperCheck(
    val pid: Long,
    val title: String,
    val nominees: List<NomineeStatus>,
    val compliance: Resolved<Compliance>,
    /** For a paper that fails: may it be referred on `nomination-noncompliance` now (through the two-person path)? Null for a compliant paper. */
    val referable: Resolved<Boolean>?,
    val warned: Boolean,
    /** What the paper's unmet obligation is (sixths), under Q19 and Q19b. */
    val shortfall: Resolved<Int>,
    val notes: List<String>,
)

/** What one person owes (`owes(u)`), in sixths of a review; null in a case means every share is pooled by the solver (Q19). */
public data class Obligation(
    val email: String,
    val tier: Tier?,
    val papers: List<Long>,
    val accepted: Boolean,
    val owes: Resolved<Int?>,
    /** Some paper that names them has a nominee still pending, so the figure may move. */
    val provisional: Boolean,
)

/** An author over Q17's cap, with the papers (never withdrawn by the tool). */
public data class CapCase(val email: String, val papers: List<Long>, val over: Int)

/** Q9: a senior author who always nominates a junior other than themself. A signal for the PC chairs only (V3). */
public data class PatternCase(val author: String, val papers: List<Long>, val nominees: List<String>, val consequence: String)

/** Something in the sheet that doesn't fit HotCRP or the rules, shown so a chair can chase it. */
public data class Anomaly(val subject: String, val message: String)

public data class NominationReport(
    val papers: List<PaperCheck>,
    val obligations: List<Obligation>,
    val patterns: List<PatternCase>,
    val capCases: Resolved<List<CapCase>>,
    val anomalies: List<Anomaly>,
) {
    public val noncompliant: List<PaperCheck> get() = papers.filter { it.compliance != Resolved.Decided(Compliance.OK) }
}

public object NominationRules {
    /** The questions each result turns on. Q7 only words the obligation (a maximum or an expectation), so it isn't one. */
    public val COMPLIANCE_QS: List<QId> = listOf(QId.Q8)
    public val SHARE_QS: List<QId> = listOf(QId.Q19, QId.Q19B)
    public val OWES_QS: List<QId> = listOf(QId.Q18, QId.Q19, QId.Q19B)

    private fun email(s: String) = s.trim().lowercase()

    /**
     * Policy cell `ac/classify` ("in the sheet, own area"): a decision counts only if the row names an AC who
     * may make it. For a nominee that is an AC of a paper that nominated them; for anyone else, an AC. A
     * decision anyone else made is never acted on (spec §11: forged traces are reported, never acted on): the
     * row is treated as pending and reported.
     */
    public fun authorised(c: Candidate, acs: Map<Long, Set<String>>): Boolean {
        val ac = email(c.acEmail)
        if (ac.isEmpty()) return false
        return if (c.origin == "nominee" && c.nominatedBy.isNotEmpty()) c.nominatedBy.any { ac in acs[it].orEmpty() } else acs.values.any { ac in it }
    }

    /** The sheet as the rules read it: an unauthorised decision demoted to pending. Also the problems found. */
    public fun effective(input: NominationInput): Pair<List<Candidate>, List<Anomaly>> {
        val anomalies = mutableListOf<Anomaly>()
        val sheet =
            input.sheet.map { c ->
                if (c.decision == Decision.PENDING || authorised(c, input.acs)) {
                    c
                } else {
                    val who = c.acEmail.ifBlank { "nobody" }
                    anomalies +=
                        Anomaly(
                            c.email,
                            "marked ${c.decision.key} by $who, who is not ${if (c.origin == "nominee") "an AC of a paper that nominated them" else "an AC"}: treated as pending, never acted on",
                        )
                    c.copy(decision = Decision.PENDING)
                }
            }
        return sheet to anomalies
    }

    public fun build(input: NominationInput, r: Readings, faults: Faults = Faults.NONE): NominationReport {
        val ids = HashMap<String, Long>()
        val (sheet, demoted) = effective(input)

        fun id(e: String): Long = ids.getOrPut(email(e)) { ids.size + 1L }
        val byEmail = sheet.associateBy { email(it.email) }
        val paperPids = input.papers.map { it.pid }.toSet()
        val anomalies = demoted.toMutableList()

        // who the sheet says each paper nominated: (candidate, pid)
        val namedBy: Map<Long, List<Candidate>> =
            sheet.flatMap { c -> c.nominatedBy.map { it to c } }.groupBy({ it.first }, { it.second })
        for (pid in namedBy.keys.filter { it !in paperPids }.sorted()) {
            anomalies += Anomaly("paper #$pid", "the sheet names nominees for paper #$pid, which HotCRP doesn't show (withdrawn, or the wrong number)")
        }
        for (c in sheet) {
            if (c.origin != "nominee" && c.nominatedBy.isNotEmpty()) anomalies += Anomaly(c.email, "origin is ${c.origin} but the row lists nominating papers")
            if (c.origin == "nominee" && c.nominatedBy.isEmpty()) anomalies += Anomaly(c.email, "origin is nominee but no paper nominated them")
            if (c.decision == Decision.ACCEPT &&
                c.consent == false
            ) {
                anomalies += Anomaly(c.email, "accepted, but they did not consent: not eligible and no membership draft")
            }
            if (c.decision == Decision.ACCEPT &&
                c.consent == null
            ) {
                anomalies += Anomaly(c.email, "accepted and classified, consent not recorded: no membership draft yet")
            }
        }

        fun registered(e: String): Boolean? = input.registered?.let { email(e) in it }

        val checks =
            input.papers.map { p ->
                val named = namedBy[p.pid].orEmpty().sortedBy { it.email }
                val authors = p.authors.map(::email).toSet()
                val statuses =
                    named.map { c ->
                        NomineeStatus(email(c.email), c.decision, c.tier, c.consent, email(c.email) in authors, registered(c.email), email(c.email) in input.pc)
                    }
                val notes = mutableListOf<String>()
                statuses.filter { !it.isAuthor }.forEach { notes += "${it.email} is nominated but is not an author of this paper" }
                if (statuses.any { it.decision == Decision.PENDING }) notes += "a nominee is still pending: obligations on this paper may move"
                // Shares are not in the sheet; where the authors allocate (Q19), an equal split stands in.
                if (statuses.size > 1) notes += "the sheet records no allocation of shares, so an equal split stands in under \"authors allocate\""
                val regKnown = input.registered != null
                if (!regKnown && statuses.isNotEmpty()) notes += "no tpms-registrations import: registration with the matching system is unchecked"
                val pn = paperNoms(p.pid, statuses, ::id)
                val reg = statuses.filter { it.registered != false }.map { id(it.email) }.toSet()
                val compliance = Resolved.of(r, COMPLIANCE_QS) { rr -> Nominations.compliance(rr.q8!!, pn, reg) }
                val warned = p.tags.any { it.substringBefore('#') == "pcs-warned" }
                val referable =
                    if (compliance == Resolved.Decided(Compliance.OK)) {
                        null
                    } else {
                        Resolved.of(r, listOf(QId.Q10)) { rr -> Nominations.mayRefer(rr.q10!!, warned) }
                    }
                val shortfall = Resolved.of(r, SHARE_QS) { rr -> Nominations.paperShortfall(faults, rr.q19!!, rr.q19b!!, pn) }
                PaperCheck(p.pid, p.title, statuses, compliance, referable, warned, shortfall, notes)
            }

        // owes(u): each person named on some paper
        val allNoms = checks.map { c -> paperNoms(c.pid, c.nominees, ::id) }
        val provisionalPids = checks.filter { c -> c.nominees.any { it.decision == Decision.PENDING } }.map { it.pid }.toSet()
        val people = checks.flatMap { c -> c.nominees.map { it.email } }.distinct().sorted()
        val obligations =
            people.map { e ->
                val cand = byEmail[e]
                val tier = cand?.tier
                val mine = checks.filter { c -> c.nominees.any { it.email == e } }.map { it.pid }
                val accepted = cand?.decision == Decision.ACCEPT
                val owes =
                    Resolved.of(r, OWES_QS) { rr ->
                        Nominations.owes(faults, rr.q18!!, rr.q19!!, rr.q19b!!, tier ?: Tier.JUNIOR, allNoms, id(e))
                    }
                Obligation(e, tier, mine, accepted, owes, mine.any { it in provisionalPids })
            }

        // Q9 patterns: one (nominee, tier) per nomination across the author's papers
        val papersOf = input.papers.flatMap { p -> p.authors.map { email(it) to p } }.groupBy({ it.first }, { it.second })

        fun tierOf(e: String): Tier? = byEmail[e]?.tier ?: if (e in input.pc && e !in byEmail) Tier.SENIOR else null
        val checkOf = checks.associateBy { it.pid }
        val patterns =
            papersOf.mapNotNull { (author, ps) ->
                val noms = ps.flatMap { p -> checkOf[p.pid]!!.nominees.map { it.email to byEmail[it.email]?.tier } }
                val flagged = Nominations.nominationPattern(id(author), tierOf(author), noms.map { id(it.first) to it.second })
                if (!flagged) {
                    null
                } else {
                    PatternCase(author, ps.map { it.pid }.sorted(), noms.map { it.first }.distinct().sorted(), Nominations.PATTERN_CONSEQUENCE)
                }
            }.sortedBy { it.author }

        // Q17: authors are matched across papers by HotCRP account
        val capCases =
            Resolved.of(r, listOf(QId.Q17)) { rr ->
                papersOf.mapNotNull { (author, ps) ->
                    val over = Nominations.papersOverCap(rr.q17!!, ps.size)
                    if (over > 0) CapCase(author, ps.map { it.pid }.sorted(), over) else null
                }.sortedBy { it.email }
            }
        return NominationReport(checks, obligations, patterns, capCases, anomalies)
    }

    private fun paperNoms(pid: Long, ns: List<NomineeStatus>, id: (String) -> Long): PaperNoms {
        // shares are in sixths of the paper's obligation: an equal split where the sheet has none
        val share = if (ns.isEmpty()) 0 else 6 / ns.size
        return PaperNoms(pid, ns.map { Nominee(id(it.email), share, it.decision == Decision.ACCEPT) })
    }

    /** Sixths of a review, for display. */
    public fun show(sixths: Int?): String = sixths?.let(Nominations::showSixths) ?: "pooled with the paper's other nominees"
}
