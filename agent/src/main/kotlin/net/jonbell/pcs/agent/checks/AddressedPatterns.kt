package net.jonbell.pcs.agent.checks

import net.jonbell.pcs.agent.extract.NormalizedText

/**
 * The pattern half of `injection.addressed` (agent.md §3.2): text addressed to an AI reader.
 * Matching runs on Unicode-normalized text (NFKC, lowercase, homoglyph fold, invisible characters
 * removed) and reports spans of the original, so a match can be quoted at its anchor.
 */
object AddressedPatterns {
    data class Pattern(val id: String, val category: String, val regex: Regex)

    data class Match(val pattern: Pattern, val start: Int, val endExclusive: Int)

    private fun p(id: String, cat: String, re: String) = Pattern(id, cat, Regex(re, setOf(RegexOption.IGNORE_CASE)))

    val patterns: List<Pattern> =
        listOf(
            // Instruction override, in English and a few other languages.
            p(
                "override-en",
                "instruction-override",
                """\b(?:ignore|disregard|forget|override)\b[^.\n]{0,30}\b(?:previous|prior|above|earlier|preceding|all|any)\b[^.\n]{0,30}\b(?:instructions?|prompts?|rules|guidelines|directions)\b""",
            ),
            p("override-en-2", "instruction-override", """\bnew instructions?\s*:"""),
            p(
                "override-es",
                "instruction-override",
                """\b(?:ignora|ignore|olvida)\b[^.\n]{0,30}\b(?:instrucciones|indicaciones)\b[^.\n]{0,20}\b(?:anteriores|previas)\b""",
            ),
            p(
                "override-fr",
                "instruction-override",
                """\bignore[zr]?\b[^.\n]{0,30}\b(?:instructions|consignes)\b[^.\n]{0,20}\b(?:pr[ée]c[ée]dentes|ant[ée]rieures)\b""",
            ),
            p(
                "override-de",
                "instruction-override",
                """\bignorier(?:e|en)?\b[^.\n]{0,30}\b(?:vorherigen|bisherigen|obigen)\b[^.\n]{0,20}\b(?:anweisungen|instruktionen)\b""",
            ),
            p("override-pt", "instruction-override", """\bignore\b[^.\n]{0,30}\binstru[cç][õo]es\b[^.\n]{0,20}\banteriores\b"""),
            p("override-zh", "instruction-override", """(?:忽略|无视|忘记)[^。\n]{0,10}(?:之前|以上|先前|上述|所有)[^。\n]{0,10}(?:指令|指示|提示|说明)"""),
            // Role markers and chat-template tokens.
            p(
                "role-marker",
                "role-marker",
                """(?<![a-z0-9])(?:system|assistant|developer)\s*:\s*[^.]{0,80}\b(?:you|your|must|always|never|ignore|reviewer|respond|output|begin)\b""",
            ),
            p(
                "chat-template",
                "chat-template",
                """<\|(?:im_start|im_end|system|user|assistant|endoftext|eot_id|start_header_id)\|>|\[/?INST]|<<\/?SYS>>|###\s*(?:instruction|system|response)\s*:|<\|begin_of_text\|>""",
            ),
            // Addressing an AI reader.
            p(
                "ai-reviewer",
                "ai-reader",
                """\bas an? (?:ai|llm|large language model|language model|automated)\b(?:[\s-]+(?:based|powered))?\s*(?:reviewer|assistant|model|system|agent)?""",
            ),
            p(
                "ai-reviewer-2",
                "ai-reader",
                """\b(?:if|when) you are an? (?:ai|llm|language model|automated)\b|\bllm reviewers?\b|\bai reviewers?\b|\bnote to (?:the )?(?:ai|llm|model|reviewing (?:ai|model))\b""",
            ),
            p("ai-reviewer-es", "ai-reader", """\bcomo (?:un |una )?(?:ia|modelo de lenguaje|revisor automático)\b"""),
            p("ai-reviewer-de", "ai-reader", """\bals (?:ki|sprachmodell)\b[^.\n]{0,20}\b(?:gutachter|reviewer|modell)\b"""),
            // Requests to rate, praise, accept, or leave out weaknesses.
            p(
                "rate-request",
                "rating-request",
                """\b(?:give|assign|award|rate|score|recommend)\b[^.\n]{0,40}\b(?:this (?:paper|work|submission)|it)\b[^.\n]{0,40}\b(?:positive|high(?:ly)?|strong|top|excellent|accept(?:ance)?|10/10|maximum|best)\b""",
            ),
            p("rate-request-2", "rating-request", """\b(?:recommend|vote for|support) (?:accept(?:ance)?|a strong accept|a (?:high|top) score)\b"""),
            p(
                "praise-request",
                "rating-request",
                """\b(?:praise|highlight|emphasi[sz]e|state|say|write)\b[^.\n]{0,40}\b(?:novelty|strengths?|contributions?|significan\w*|groundbreaking)\b[^.\n]{0,40}\b(?:significant|exceptional|novel|groundbreaking|strong|praise)\b|\bpraise this (?:paper|work)\b""",
            ),
            p(
                "omit-weakness",
                "rating-request",
                """\b(?:do not|don't|never|avoid|omit|refrain from)\b[^.\n]{0,30}\b(?:mention|mentioning|point out|pointing out|discuss|discussing|report|list|listing|include|raise)\b[^.\n]{0,30}\b(?:weakness(?:es)?|limitations?|flaws?|problems?|criticisms?|negatives?)\b""",
            ),
            p(
                "canary-phrase",
                "instruction-override",
                """\b(?:end|begin|start|finish)\b[^.\n]{0,20}\b(?:your|the) (?:response|answer|review|report|output)\b[^.\n]{0,20}\bwith\b[^.\n]{0,20}\b(?:phrase|word|string|token)\b|\binclude the (?:exact )?(?:phrase|word|string)\b""",
            ),
            p("rate-zh", "rating-request", """(?:给|请给)[^。\n]{0,10}(?:这篇|本)[^。\n]{0,6}(?:论文|文章)[^。\n]{0,10}(?:高分|好评|接受)"""),
        )

    fun scan(original: String): List<Match> {
        if (original.isBlank()) return emptyList()
        val n = NormalizedText(original)
        val out = mutableListOf<Match>()
        for (pat in patterns) {
            for (m in pat.regex.findAll(n.text)) {
                if (m.value.isBlank()) continue
                val r = n.originalRange(m.range.first, m.range.last + 1)
                out += Match(pat, r.first, r.last + 1)
            }
        }
        return merge(out)
    }

    /** Overlapping matches become one span; the first pattern keeps the label. */
    private fun merge(ms: List<Match>): List<Match> {
        val sorted = ms.sortedWith(compareBy({ it.start }, { -it.endExclusive }))
        val out = mutableListOf<Match>()
        for (m in sorted) {
            val last = out.lastOrNull()
            if (last != null && m.start < last.endExclusive) {
                if (m.endExclusive > last.endExclusive) out[out.lastIndex] = Match(last.pattern, last.start, m.endExclusive)
            } else {
                out += m
            }
        }
        return out
    }

    /** True when the page text is about LLMs or prompt injection, where visible matches are expected. */
    fun aboutLlms(text: String): Boolean {
        val t = text.lowercase()
        val hits =
            listOf("prompt injection", "large language model", "llm", "jailbreak", "adversarial prompt", "instruction-following").sumOf {
                Regex(Regex.escape(it)).findAll(t).count()
            }
        return hits >= 4
    }
}
