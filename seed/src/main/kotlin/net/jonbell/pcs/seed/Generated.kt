package net.jonbell.pcs.seed

import net.jonbell.pcs.seed.At.Companion.disc
import kotlin.random.Random

/**
 * Generated scenarios (PLAN M2): `shadow` (~150 papers, realistic spread, for demos and manual UI
 * work) and `scale` (~4,000 papers, the design target, for the nightly scale job). A fixed seed
 * makes each one the same on every run. Everything is synthetic.
 */
object Generated {
    data class Size(val papers: Int, val acs: Int, val seniors: Int, val juniors: Int, val nominees: Int)

    val SHADOW = Size(papers = 150, acs = 6, seniors = 45, juniors = 25, nominees = 60)
    val SCALE = Size(papers = 4000, acs = 65, seniors = 600, juniors = 300, nominees = 2400)

    fun scenario(name: String, size: Size, seed: Long = 20301): Scenario {
        val rnd = Random(seed)

        fun e(s: String) = "$s@example.org"
        val acs = (1..size.acs).map { e("ac$it") }
        val seniors = (1..size.seniors).map { e("sen$it") }
        val juniors = (1..size.juniors).map { e("jun$it") }
        val nominees = (1..size.nominees).map { e("nom$it") }
        val pc =
            acs.mapIndexed { i, a -> PcUser(a, "Area", "Chair${i + 1}") } +
                seniors.mapIndexed { i, a -> PcUser(a, "Senior", "Member${i + 1}") } +
                juniors.mapIndexed { i, a -> PcUser(a, "Junior", "Member${i + 1}", tags = listOf("junior")) } +
                nominees.mapIndexed { i, a -> PcUser(a, "Nominee", "Number${i + 1}", tags = listOf("nominee")) }
        val papers = (1..size.papers).map { Paper(it, "Synthetic Paper $it", listOf(e("author$it"), e("author${it}b"))) }
        val assignments = mutableListOf<Assign>()
        val events = mutableListOf<Event>()
        for (p in 1..size.papers) {
            val ac = acs[(p - 1) % acs.size]
            val revs =
                listOf(seniors[rnd.nextInt(seniors.size)], seniors[rnd.nextInt(seniors.size)]).distinct() +
                    (if (rnd.nextBoolean()) juniors[rnd.nextInt(juniors.size)] else nominees[rnd.nextInt(nominees.size)])
            assignments += Assign(p, "metareview", ac)
            revs.forEach { assignments += Assign(p, "primary", it) }
            val quality = rnd.nextInt(5)
            revs.forEachIndexed { i, r ->
                if (rnd.nextInt(100) < 95) { // about 5% of reviews are still missing
                    val merit = (quality + rnd.nextInt(-1, 2)).coerceIn(1, 5)
                    events +=
                        SubmitReview(
                            p,
                            r,
                            merit,
                            rnd.nextInt(1, 5),
                            if (rnd.nextInt(100) <
                                5
                            ) {
                                40
                            } else {
                                150 + rnd.nextInt(300)
                            },
                            disc(-14.0 + i * 0.1 + rnd.nextDouble()),
                        )
                }
            }
            repeat(rnd.nextInt(0, 5)) {
                val who = if (rnd.nextInt(3) == 0) ac else revs[rnd.nextInt(revs.size)]
                events += PostComment(p, who, "Synthetic discussion comment.", disc(rnd.nextDouble() * 14))
            }
            if (rnd.nextInt(100) < 30) events += PostComment(p, e("author$p"), "Synthetic author response.", disc(-3), response = true)
        }
        return Scenario(name, pc, papers, assignments, events)
    }
}
