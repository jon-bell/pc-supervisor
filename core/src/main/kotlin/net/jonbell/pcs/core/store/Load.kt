package net.jonbell.pcs.core.store

/**
 * Reviewer load as the solver counts it (spec §11, S11): reviews assigned to a PC member or
 * external reviewer, **not** the metareviews of ACs and **not** screen-round reviews, which are
 * second opinions and must not change what the solver thinks a member can take.
 */
public object Load {
    public fun byPerson(store: Store): Map<String, Int> =
        store.conn.query(
            "SELECT lower(email), count(*) FROM review WHERE gone_at IS NULL AND email IS NOT NULL AND rtype <> 5 AND coalesce(round, '') <> 'screen' GROUP BY lower(email)",
        ) { it.getString(1) to it.getInt(2) }.toMap()
}
