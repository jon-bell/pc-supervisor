package pcs.core.nominations

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import pcs.core.imports.ImportKind
import pcs.core.imports.Imports
import pcs.core.readings.Readings
import pcs.core.rules.Tier
import pcs.core.store.Store
import pcs.core.store.query

/** Reads the mirror and the latest imports into a [NominationInput] and builds the report. */
public class NominationData(private val store: Store, private val imports: Imports) {
    public fun input(): NominationInput {
        val papers =
            store.conn.query("SELECT pid, coalesce(title,''), authors, tags FROM paper WHERE gone_at IS NULL ORDER BY pid") { r ->
                PaperInfo(
                    r.getLong(1),
                    r.getString(2),
                    Json.parseToJsonElement(r.getString(3)).jsonArray.map { it.jsonPrimitive.content }.filter { it.isNotBlank() },
                    Json.parseToJsonElement(r.getString(4)).jsonArray.map { it.jsonPrimitive.content },
                )
            }
        val pc = store.conn.query("SELECT email FROM person WHERE gone_at IS NULL") { it.getString(1).lowercase() }.toSet()
        val sheet =
            imports.latest(ImportKind.APPOINTMENTS)?.rows.orEmpty().map { row ->
                val d = row.data
                Candidate(
                    email = row.key,
                    origin = d["origin"].orEmpty(),
                    nominatedBy = d["nominated_by"].orEmpty().split(';').mapNotNull { it.toLongOrNull() },
                    area = d["area"].orEmpty(),
                    acEmail = d["ac_email"].orEmpty(),
                    decision = Decision.ofKey(d["decision"].orEmpty()),
                    tier = d["tier"]?.takeIf { it.isNotEmpty() }?.let { if (it == "senior") Tier.SENIOR else Tier.JUNIOR },
                    consent = d["consent"]?.takeIf { it.isNotEmpty() }?.let { it == "yes" },
                    onPcAt = d["on_pc_at"].orEmpty(),
                )
            }
        val registered =
            imports.latest(ImportKind.TPMS_REGISTRATIONS)?.rows?.filter { it.data["registered"] == "yes" }?.map { it.key.lowercase() }?.toSet()
        val acs =
            store.conn.query("SELECT pid, email FROM review WHERE rtype = 5 AND gone_at IS NULL AND email IS NOT NULL") {
                it.getLong(1) to
                    it.getString(2).lowercase()
            }
                .groupBy({ it.first }, { it.second }).mapValues { it.value.toSet() }
        return NominationInput(papers, sheet, pc, registered, acs)
    }

    public fun report(r: Readings): NominationReport = NominationRules.build(input(), r)
}
