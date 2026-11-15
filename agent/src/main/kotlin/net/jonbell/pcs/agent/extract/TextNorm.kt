package net.jonbell.pcs.agent.extract

import java.text.Normalizer

/**
 * Unicode normalization that remembers where each normalized character came from, so a match in
 * normalized text is reported as a span of the original (and so can be quoted at its anchor).
 */
class NormalizedText(val original: String) {
    val text: String
    private val origin: IntArray

    init {
        val sb = StringBuilder()
        val map = ArrayList<Int>()
        var i = 0
        while (i < original.length) {
            val cp = original.codePointAt(i)
            val n = Character.charCount(cp)
            if (!Invisible.isInvisible(cp)) {
                val folded = Normalizer.normalize(String(Character.toChars(cp)), Normalizer.Form.NFKC).lowercase()
                for (c in Confusables.fold(folded)) {
                    // Collapse whitespace runs to one space.
                    if (c.isWhitespace()) {
                        if (sb.isNotEmpty() && sb.last() != ' ') {
                            sb.append(' ')
                            map += i
                        }
                    } else {
                        sb.append(c)
                        map += i
                    }
                }
            }
            i += n
        }
        text = sb.toString()
        origin = map.toIntArray()
    }

    /** The original span `[start, end)` for a normalized span. */
    fun originalRange(start: Int, endExclusive: Int): IntRange {
        val s = origin[start]
        val lastStart = origin[endExclusive - 1]
        val e = lastStart + Character.charCount(original.codePointAt(lastStart))
        return s until e
    }
}

/** Characters a reader never sees (agent.md §3.2: zero-width, Unicode tag, bidi override). */
object Invisible {
    enum class Kind(val vector: String) { ZERO_WIDTH("zero-width"), TAG("unicode-tag"), BIDI("bidi-override") }

    fun kind(cp: Int): Kind? =
        when (cp) {
            0x200B, 0x200C, 0x200D, 0x2060, 0x2061, 0x2062, 0x2063, 0x2064, 0xFEFF, 0x180E -> Kind.ZERO_WIDTH
            0x202A, 0x202B, 0x202C, 0x202D, 0x202E, 0x2066, 0x2067, 0x2068, 0x2069, 0x200E, 0x200F -> Kind.BIDI
            in 0xE0000..0xE007F -> Kind.TAG
            else -> null
        }

    fun isInvisible(cp: Int) = kind(cp) != null

    /** A run of invisible characters in `s`, with what it decodes to where an encoding is recognizable. */
    data class Run(val start: Int, val end: Int, val kinds: Set<Kind>, val decoded: String?)

    fun runs(s: String): List<Run> {
        val out = mutableListOf<Run>()
        var i = 0
        while (i < s.length) {
            val cp = s.codePointAt(i)
            if (kind(cp) == null) {
                i += Character.charCount(cp)
                continue
            }
            val start = i
            val kinds = mutableSetOf<Kind>()
            // A bidi override runs to its pop (PDF) or the end of the line, visible characters included.
            var j = i
            while (j < s.length) {
                val c = s.codePointAt(j)
                val k = kind(c)
                if (k == null && Kind.BIDI !in kinds) break
                if (k == null && (s[j] == '\n')) break
                if (k != null) kinds += k
                j += Character.charCount(c)
                if (c == 0x202C) break
            }
            out += Run(start, j, kinds, decode(s.substring(start, j)))
            i = j
        }
        return out
    }

    /** Decodes tag characters (U+E0020–E007E → ASCII), ZWSP/ZWNJ binary, and bidi overrides (the run as displayed). */
    fun decode(run: String): String? {
        val cps = run.codePoints().toArray()
        if (cps.isNotEmpty() && cps.all { it in 0xE0000..0xE007F }) {
            return cps.filter { it in 0xE0020..0xE007E }.joinToString("") { (it - 0xE0000).toChar().toString() }
        }
        if (cps.size >= 8 && cps.size % 8 == 0 && cps.all { it == 0x200B || it == 0x200C }) {
            return cps.toList().chunked(8).joinToString("") { bits -> bits.fold(0) { acc, b -> acc * 2 + if (b == 0x200C) 1 else 0 }.toChar().toString() }
        }
        if (cps.firstOrNull() == 0x202E) {
            return cps.filter { kind(it) == null }.reversed().joinToString("") { String(Character.toChars(it)) }
        }
        return null
    }
}

/** A small homoglyph fold (Cyrillic and Greek look-alikes of Latin letters), applied after NFKC. */
object Confusables {
    private val map =
        mapOf(
            'а' to 'a',
            'е' to 'e',
            'о' to 'o',
            'р' to 'p',
            'с' to 'c',
            'у' to 'y',
            'х' to 'x',
            'і' to 'i',
            'ј' to 'j',
            'ѕ' to 's',
            'α' to 'a',
            'ο' to 'o',
            'ρ' to 'p',
            'ν' to 'v',
            'ι' to 'i',
            'κ' to 'k',
            'τ' to 't',
        )

    fun fold(s: String): String = buildString { s.forEach { append(map[it] ?: it) } }
}
